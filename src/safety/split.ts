// Reads a shell command line into its separate commands, for the dangerous-command check (release 7 design, "The
// dangerous-command check"; plan, Task 2 and choices 2, 3 and 32-42). Tachikoma's own reader: bash's grammar,
// PowerShell's, and cmd's for the text `cmd /c` runs. It is strict where it does not understand: anything it cannot read
// makes the whole line unreadable, which the check counts as dangerous.

export type Shell = "bash" | "powershell";
// `words` have their quotes taken off; `text` is the command as written, for the warning that names it.
export interface Command {
  words: string[];
  text: string;
}
// `commands` holds each command once; `all` holds every command in the order read, repeats included, so that rules.ts
// can count each cd written on the line (`cd .. && cd ..` is two). A script block the reader reads both as a block and as
// powershell's text is in `all` once.
export type Split = { commands: Command[]; all: Command[] } | { unreadable: string }; // why, in plain words

// The shell a command runs in (choice 3): PowerShell on a Windows host, /bin/sh (read as bash) on any other, bash in the box.
export function shellOf(where: "host" | "box", platform: NodeJS.Platform = process.platform): Shell {
  return where === "host" && platform === "win32" ? "powershell" : "bash";
}

export function split(line: string, shell: Shell): Split {
  try {
    const commands = read(line, shell).commands;
    return { commands: once(commands), all: commands.filter((c) => !REREAD.has(c)) };
  } catch (error) {
    if (error instanceof Unreadable) return { unreadable: error.message };
    // Brackets nested deeper than JavaScript's stack: no depth is set here, as none has a source.
    if (error instanceof RangeError && /call stack/i.test(error.message)) return { unreadable: DEEP };
    throw error;
  }
}

// Thrown with the reason a line cannot be read.
class Unreadable extends Error {}

const UNCLOSED = "an unclosed quote";
const HEREDOC = "a here-document";
const PROCESS = "a process substitution";
const ENCODED = "-EncodedCommand, whose text cannot be read";
const EVAL = "text run by eval";
const IEX = "text run by Invoke-Expression";
const PIPED = "text piped into a shell";
const UNPAIRED = "a bracket without its pair";
const MISPLACED = "a bracket where a command cannot have one";
const NO_FILE = "a redirection without its file";
const CMD_IF = "cmd's if or for, which the check does not read";
const NAMED = "a command named only when it runs";
const MADE = "shell text made only when it runs";
const FOLLOW = "a way of running text the check does not follow";
const OTHER = "text run by a shell the check does not read";
const DEEP = "nesting too deep for the check to read";
const unknownOption = (name: string, option: string) => new Unreadable(`${name} ${option}, an option the check does not read`);
const requoted = (name: string) => new Unreadable(`PowerShell would change its quotes before ${name} reads it`);

type Grammar = Shell | "cmd";
// What closes the part being read: a bracket; ;; (or ;& or ;;&) or esac for an arm of bash's case; or "" for the end.
type Stop = "" | ")" | "}" | ";;";
// What a redirection was (Reader.redirection): a file; a file in place of the input; a here-document or here-string on
// the input; another file number copied into the input; a process substitution on the input, on the output, or on any
// other file number; or no redirection at all.
type Redirect = "file" | "input" | "text" | "copy" | "piped" | "procsub" | "procsub-other" | false;
// One command read (Reader.command): its commands and the separator after it, what in it reads its input, the compound
// commands it opens and closes, how its input is replaced, and whether it is only a PowerShell string.
interface CommandRead extends Part {
  sep: string;
  opens: number;
  closes: number;
  fed: boolean;
  piped: boolean;
  replaced: boolean;
  literal: boolean;
}
interface Word {
  value: string; // quotes taken off
  start: number; // where it is in the text read
  end: number;
  dynamic: boolean; // holds a variable or a command's output, so it is known only when it runs
  shape: string; // bash: the word as written, with each quoted or escaped part as \0, for globs and brace expansion
  single?: boolean; // PowerShell: the word is exactly one string or here-string, with nothing before or after it
  fed?: boolean; // bash: the word is a process substitution, <(...) or >(...), whose file is a command's output
}
// Whether something in a part of a line reads the part's input as code: a shell, or an interpreter such as python. Fed a
// pipe, either runs text the check never sees. Fed a here-document or here-string, an interpreter runs code written in the
// line, as with -c, and is read (choice 38), while a shell stays unreadable (choice 35). Ranked, so the larger wins.
type Hunger = 0 | 1 | 2;
const NONE: Hunger = 0;
const CODE: Hunger = 1;
const SHELL: Hunger = 2;
const most = <T extends number>(a: T, b: T): T => (a > b ? a : b);
// The commands read from a part of a line, what in them reads the part's input, and whether a shell or an interpreter is run.
interface Part {
  commands: Command[];
  hungry: Hunger;
  program?: boolean;
  arith?: string[]; // bash: the names used in the part's arithmetic (Reader.counted)
  subs?: Subs; // bash: the command substitutions read in it (Reader.subs)
}
// bash: command substitutions read as such: $( and backtick pairs (Reader.checkArithmetic).
interface Subs {
  dollars: number;
  ticks: number;
}
// Adds a part's command substitutions to a count.
function addSubs(into: Subs, part: Part): void {
  into.dollars += part.subs?.dollars ?? 0;
  into.ticks += part.subs?.ticks ?? 0;
}
// What a shell is given to run: its text in a grammar, whether that text is made only when the line runs, and whether
// the reader has read it already (a script block given to powershell, read as a block too).
interface Runs {
  grammar: Grammar;
  texts: string[];
  dynamic: boolean;
  again?: boolean;
}
// The commands read a second time (Runs.again), left out of Split's `all`.
const REREAD = new WeakSet<Command>();

// Words before a command that are bash's own, not the command's; those that open and close a compound command.
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!"]);
const OPENS = new Set(["if", "while", "until", "for", "select"]);
const CLOSES = new Set(["fi", "done"]);
const SH = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "rbash", "yash", "posh"]);
// PowerShell's ways of running text, starting a program, or making a command, that the check does not follow (choice 37).
const PS_FOLLOW = new Set([
  "start-process", "saps", "start", "set-alias", "new-alias", "sal", "nal", "invoke-cimmethod", "invoke-wmimethod", "iwmi", "add-type",
]);
const PS_FOLLOW_TEXT = new RegExp(
  [
    /\[\s*(system\.)?(management\.automation\.)?scriptblock\s*\]\s*::\s*create/.source,
    /\.(invokescript|addscript)\s*\(/.source,
    /\.invokecommand\b/.source,
    /\[\s*(system\.)?diagnostics\.process\s*\]\s*::\s*start/.source,
    /(^|[^\w-])function:(?=\S)/.source, // a path on the function: drive, which makes a function from text
  ].join("|"),
  "i",
);
// A COM object's Run, Exec or ShellExecute (WScript.Shell, Shell.Application) starts a program from text.
const PS_COM = /-com(o|ob|obj|obje|objec|object)?\b/i;
const PS_COM_RUN = /\.(run|exec|shellexecute)\s*\(/i;
// PowerShell's reach into .NET that asks (choice 39), matched in the line's code with its strings as '' (Reader.dotnet).
const PS_DOTNET = new RegExp(
  [
    /[\w)\]]\.\s*''\s*\(/.source, // a quoted member name called, as in .'Delete'()
    /[\w)\]]\.\s*\(/.source, // a member name worked out, as in .($name)
    /[\w)\]]\.\s*\$[\w:]+\s*\(/.source, // a member named by a variable and called
    /\.\s*(invoke|create|start)\s*\(/.source,
    /createpipeline|getscriptblock|parseinput|invokemember|gettypefromprogid|activator/.source,
    /\[\s*(system\.management\.)?(wmiclass|wmi|wmisearcher|managementclass|managementobject)\s*\]/.source,
  ].join("|"),
);
// The .NET types whose static members only read or compute (choice 39): all of a type's members (true), or those listed.
// Names are in lower case, without System.
const DOTNET_READS: Record<string, true | string[]> = {
  "io.path": true,
  "io.file": ["exists", "readalltext", "readalllines", "readallbytes"], // not Delete, Move, Write... which change files
  datetime: true,
  math: true,
  convert: true,
  "text.encoding": true,
  string: true,
  char: true,
  int: true,
  int32: true,
  long: true,
  int64: true,
  double: true,
  decimal: true,
  bool: true,
  boolean: true,
  guid: true,
  timespan: true,
  timezoneinfo: true, // finding and converting time zones
  bitconverter: true,
  regex: ["escape", "match", "matches", "ismatch", "split", "replace"],
  "text.regularexpressions.regex": ["escape", "match", "matches", "ismatch", "split", "replace"],
  // [Environment]: its Get... members and the properties it only reads, not Set... or Exit.
  environment: [
    "newline", "machinename", "currentdirectory", "osversion", "processorcount", "username", "userdomainname",
    "is64bitoperatingsystem", "is64bitprocess", "systemdirectory", "tickcount", "tickcount64", "version", "workingset",
    "processid", "processpath", "systempagesize", "userinteractive", "hasshutdownstarted", "currentmanagedthreadid",
    "commandline", "stacktrace", "expandenvironmentvariables",
  ],
  // [Console]: the encodings (as in `[Console]::OutputEncoding = [Text.Encoding]::UTF8`), writing, and what it only reads.
  console: [
    "outputencoding", "inputencoding", "write", "writeline", "windowwidth", "windowheight", "bufferwidth", "isoutputredirected",
    "isinputredirected", "iserrorredirected",
  ],
  "io.directory": ["exists", "getfiles", "getdirectories", "enumeratefiles", "enumeratedirectories", "getcurrentdirectory"],
  "diagnostics.stopwatch": ["startnew"],
  // Collections and a string builder, which are only made new.
  "collections.generic.list": ["new"],
  "collections.generic.dictionary": ["new"],
  "collections.generic.hashset": ["new"],
  "collections.generic.queue": ["new"],
  "collections.generic.stack": ["new"],
  "collections.generic.sorteddictionary": ["new"],
  "collections.arraylist": ["new"],
  "collections.hashtable": ["new"],
  "text.stringbuilder": ["new"],
};
// A generic type's arguments, as in List[string], are taken off before it is looked up.
function readsOnly(type: string, member: string): boolean {
  const plain = type.replace(/\[.*\]$/, "");
  const reads = DOTNET_READS[plain];
  if (plain === "environment" && member.startsWith("get")) return true;
  return reads === true || (reads !== undefined && reads.includes(member));
}
// Value types a string may be cast to (choice 39), in lower case, without System.: a cast to any other type asks.
const STRING_CASTS = new Set([
  "int", "int32", "long", "int64", "double", "decimal", "string", "bool", "boolean", "char", "datetime", "timespan", "version", "guid",
  "regex", "text.regularexpressions.regex", "uri", "xml", "xml.xmldocument",
]);
// PowerShell takes curly quotes as quotes too (about_Quoting_Rules).
const PS_SINGLE = new Set(["'", "\u2018", "\u2019", "\u201A", "\u201B"]);
const PS_DOUBLE = new Set(['"', "\u201C", "\u201D", "\u201E"]);
const HERE_STRING = /@['"\u2018-\u201E][ \t]*\n/y;
// Backslash escapes in bash's $'...' (bash manual, "ANSI-C Quoting") and backtick escapes in PowerShell's double quotes
// (about_Special_Characters).
const C_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
};
const PS_ESCAPES: Record<string, string> = { "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
// The largest Unicode code point; an escape past it is kept as nothing, as no character has it.
const codePoint = (n: number) => (n <= 0x10ffff ? String.fromCodePoint(n) : "");

// Where a cd earlier on the line may have left the shell (choice 37): in a known folder; perhaps at /, after climbing with ..;
// or anywhere, after a cd to a folder under /dev or /proc, or to one known only when the line runs. Ranked, so the larger wins.
type Cwd = 0 | 1 | 2;
const KNOWN: Cwd = 0;
const ROOT: Cwd = 1;
const ANYWHERE: Cwd = 2;

// What a shell started by a command inherits from the line: its exported NAME=value words, and the folder it starts in.
interface Inherited {
  env: Word[];
  cwd: Cwd;
  positional?: boolean; // a shell's text, whose positional parameters may be words the line gives it
}

function read(text: string, grammar: Grammar, from?: Inherited): Part {
  const reader = new Reader(text.replace(/\r\n/g, "\n"), grammar, from);
  const part = reader.sequence("");
  reader.dotnet();
  reader.checkArithmetic();
  return { ...part, arith: [...reader.arith], subs: { ...reader.subs } };
}

// Whether a path names a process's own input (choice 37). An absolute path is tidied by its text alone: repeated slashes
// joined, . and .. taken out; then anything under /dev or /proc counts, as /dev/stdin, /dev/fd/0 and /proc/<n>/fd/0 have
// many spellings. A relative or ~ path counts when /dev or /proc comes after a .., as enough .. reaches / from any folder,
// and also, after a cd, as `cwd` says. /dev/null, which reads as nothing, never counts.
function ownInput(path: string, cwd: Cwd = KNOWN): boolean {
  if (path === "" || /(^|\/)dev\/+null\/*$/.test(path)) return false;
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (path.startsWith("/")) {
    const tidy = tidied(path);
    return tidy[0] === "dev" || tidy[0] === "proc";
  }
  const climbed = parts.indexOf("..");
  if (climbed >= 0 && parts.slice(climbed + 1).some((p) => p === "dev" || p === "proc")) return true;
  if (path.startsWith("~")) return false;
  return cwd === ANYWHERE || (cwd === ROOT && (parts[0] === "dev" || parts[0] === "proc"));
}

// An absolute path's parts, tidied by its text alone: repeated slashes joined, . and .. taken out. / gives none.
function tidied(path: string): string[] {
  const tidy: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") tidy.pop();
    else if (part !== "" && part !== ".") tidy.push(part);
  }
  return tidy;
}

// Whether text holds a path to the input, or a lone -: an option's value, a script, or a start-up setting such as
// NODE_OPTIONS='--import=/dev/stdin' or RUBYOPT=-r/dev/stdin. It is taken apart at blanks, = and commas, and a short
// option's letters before a path are taken off. PHP's php://stdin and php://fd/0 count too.
function holdsInput(text: string, cwd: Cwd = KNOWN): boolean {
  if (/php:\/\/(stdin|fd\/0)/i.test(text)) return true;
  return text.split(/[\s=,;]+/).some((t) => t === "-" || ownInput(t, cwd) || ownInput(t.replace(/^-[A-Za-z]+/, ""), cwd));
}

// Whether a word names a process's own input, or a file known only when the line runs: either may be the pipe. A process
// substitution, as in `bash <(curl x)`, is another command's output given as the script: text piped into a shell.
function takesInput(word: Word, cwd: Cwd = KNOWN): boolean {
  if (word.fed) throw new Unreadable(PIPED);
  return word.dynamic || ownInput(word.value, cwd);
}

// What a command's reading depends on, beyond its words.
interface Context {
  inner: boolean; // it is in another's words, as in `env rm`, so its name is a program's whatever the grammar
  placeholder?: string; // what xargs -I or find -exec replaces in the words when it runs
  vars: Word[]; // the NAME=value words set for it: before it, through env or sudo, or earlier on the line
  functions: Map<string, Hunger>; // the line's bash functions and aliases, and what in each reads its input
  cwd: Cwd;
  lost?: () => void; // called for a cd, pushd or popd in another's words, which leaves the shell anywhere
}
const MOVES = new Set(["cd", "pushd", "popd"]);

// bash's commands that declare variables (export, declare and the like), those of them that also take -i and -n (typed),
// and those that read their input into one (bash's help for each).
const DECLARERS = ["export", "declare", "typeset", "local", "readonly"];
const TYPED = ["declare", "typeset", "local"];
const READERS = ["read", "mapfile", "readarray"];
// The commands that set a variable named in their words: the declarers (NAME or NAME=value), the readers (their names),
// printf -v NAME, let NAME=..., unset and getopts.
const NAMES = new Set([...DECLARERS, ...READERS, "printf", "let", "unset", "getopts"]);
// bash's builtins (bash 5.2's `help`), which may read a word as a variable's name.
const BUILTINS = new Set([
  ":", ".", "[", "[[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "compopt", "continue",
  "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help",
  "history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly",
  "return", "set", "shift", "shopt", "source", "suspend", "test", "times", "trap", "true", "type", "typeset", "ulimit", "umask",
  "unalias", "unset", "wait",
]);
// The readers' options that take the next word (bash's help for each): read's -d, -i, -n, -N, -p, -t and -u; mapfile's
// and readarray's -d, -n, -O, -s, -u, -C and -c (their -t takes none). Only these are skipped, so that no name is taken
// for a value.
const READER_VALUES: Record<string, string> = { read: "dinNptu", mapfile: "dnOsuCc", readarray: "dnOsuCc" };

// Whether set gives the positional parameters: any operand, after -- or - or none, other than the name after -o or +o
// (bash's help set).
function setsPositional(args: Word[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.value;
    if (a === "--" || a === "-") return k + 1 < args.length;
    if (!/^[-+]/.test(a)) return true;
    if (/^[-+]\w*o$/.test(a)) k++;
  }
  return false;
}

// The names a reader writes, after its options and their values: the words given, or the variable it writes when given
// none (REPLY for read, MAPFILE for mapfile and readarray).
function readerNames(name: string, args: Word[]): string[] {
  const names: string[] = [];
  const values = READER_VALUES[name] ?? "";
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.value;
    if (!a.startsWith("-")) names.push(a);
    else if (a.length === 2 && values.includes(a[1]!)) k++;
  }
  return names.length > 0 ? names : [name === "read" ? "REPLY" : "MAPFILE"];
}

// printf -v NAME (or -vNAME): the word naming the variable printf writes, and the name in it.
function printfTarget(args: Word[]): { word: Word; name: string } | undefined {
  const k = args.findIndex((w) => /^-v/.test(w.value));
  const v = args[k];
  if (!v) return undefined;
  if (v.value !== "-v") return { word: v, name: v.value.slice(2) };
  const next = args[k + 1];
  return next && { word: next, name: next.value };
}
// A command anywhere on the line that sets a variable whose name is made only when it runs, or makes a nameref.
const DYNAMIC_SETTER = new RegExp(
  [
    /\b(export|declare|typeset|local|readonly|read|mapfile|readarray|unset|getopts|let)\b[^\n;&|]*?\s["']?[$`]/.source,
    /\bprintf\b[^\n;&|]*?\s-v\s*["']?[$`]/.source,
    /\b(declare|typeset|local)\b[^\n;&|]*?\s-\w*n/.source,
  ].join("|"),
);
// How a value the line writes to a variable stands for arithmetic (choice 42), given as written: "fine" for nothing, a
// plain integer (quoted or not), exactly one $(( )) or one command substitution (its output is the known limit), $#, $?
// or a length ${#x}; "copy:NAME" for exactly $NAME or ${NAME}, and "copy:@" for a positional parameter ($1, ${1}, $@, $*),
// which the line may give (POSITIONAL); "code" for anything else, as text the line writes could hide code there, split or
// escaped (X=a[\$\(rm\ x\)]).
type Judgement = "fine" | "code" | `copy:${string}`;
// Positional parameters ($1, ${1}, $@, $*) stand as this one name in arithmetic and in writes: code when the line gives
// them, by set with an operand, to a function it defines, or to a shell's text it runs; from outside the line otherwise.
const POSITIONAL = "@";
function judged(raw: string): Judgement {
  const v = /^"([\s\S]*)"$/.exec(raw)?.[1] ?? raw;
  if (v === "" || /^[+-]?\d+$/.test(v) || /^'[+-]?\d+'$/.test(raw)) return "fine";
  if ((v.startsWith("$(") && closesAtEnd(v, 1)) || /^`[^`]*`$/.test(v) || /^\$[#?]$/.test(v)) return "fine";
  if (/^\$(?:\d+|\{\d+\}|[@*])$/.test(v)) return `copy:${POSITIONAL}`;
  if (/^\$\{#[^}]*\}$/.test(v)) return "fine"; // a length, ${#x}, is a number
  const copy = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(v);
  return copy ? `copy:${copy[1] ?? copy[2]}` : "code";
}

// Whether the bracket that opens at `at` closes at the text's very end.
function closesAtEnd(text: string, at: number): boolean {
  let depth = 0;
  for (let k = at; k < text.length; k++) {
    if (text[k] === "(") depth++;
    else if (text[k] === ")" && --depth === 0) return k === text.length - 1;
  }
  return false;
}

// A variable's name as a plain word on the line, its letters perhaps split by quotes (H"OME"), not inside $NAME or ${NAME}.
function plainName(name: string): RegExp {
  const quotes = "[\"']*";
  return new RegExp(`(?<![\\w$])(?<!\\$\\{[#!]?)${quotes}${[...name].join(quotes)}${quotes}(?!\\w)`);
}

// Each command is kept once: every repeated command is dropped, so `rm x; rm x` gives one. Some text is read twice, too: a
// script block passed to powershell, as a block and as the shell's text, and cmd's text read both ways (cmdText).
function once(commands: Command[]): Command[] {
  const seen = new Set<string>();
  return commands.filter((c) => {
    const key = JSON.stringify(c);
    return !seen.has(key) && !!seen.add(key);
  });
}

// A bash here-document whose body comes after the line it is on: the line that ends it, whether that line and the body's lines
// lose their leading tabs (<<-), and whether bash expands the body (an unquoted end word).
interface HereDoc {
  end: string;
  strip: boolean;
  expands: boolean;
}

class Reader {
  private i = 0;
  private readonly escape: string;
  private pending: HereDoc[] = []; // here-documents begun at this bracket's level, whose bodies come after the line
  private waiting = 0; // here-documents begun outside the bracket being read: a new line here is not where their bodies are
  private dynamic = false; // the word being read holds a variable or a command's output
  hungry: Hunger = NONE; // what in the brackets of the command being read reads that command's input
  // bash functions and aliases made on this line, and what in each reads its input; an alias's text is not read.
  private readonly functions = new Map<string, Hunger>();
  // NAME=value words set on the line in any way: on their own, by export, declare, typeset, readonly or local. Later
  // commands may see them, as `set -a` exports every one.
  private readonly exported: Word[] = [];
  private cwd: Cwd = KNOWN;
  private psCode = ""; // PowerShell: the line's code with each string as '', for the .NET checks (choice 39)
  private readonly written = new Set<string>(); // bash: the names written by name-setting commands read so far
  private writtenAll = false; // bash: a name-setting command whose name is made when it runs, or a nameref, was read
  // bash: the names used in arithmetic (Reader.counted). Arithmetic reads a name's value as arithmetic too, and runs any
  // $(...) in an array index there, as in X='a[$(rm x)]'; (( X )).
  readonly arith = new Set<string>();
  // bash: the command substitutions read as such, $( and backtick pairs, counted against the line's own text (choice 42).
  readonly subs: Subs = { dollars: 0, ticks: 0 };
  // bash: each write to a name seen on the line, judged for arithmetic (Reader.judged): "fine", "code" (text the line
  // writes that could hide code), or "copy:NAME" for a plain copy of another variable.
  private readonly writes = new Map<string, Judgement[]>();
  // bash: names read by read, mapfile or readarray: fine unless a here-document or here-string on the line feeds them,
  // their own or their loop's or group's, which marks them as code there (choice 42).
  private readonly reads: string[] = [];

  constructor(
    private readonly src: string,
    private readonly g: Grammar,
    from?: Inherited,
  ) {
    this.escape = g === "bash" ? "\\" : g === "powershell" ? "`" : "^";
    if (g === "powershell" && PS_COM.test(src) && PS_COM_RUN.test(src)) throw new Unreadable(FOLLOW);
    if (from) {
      this.exported.push(...from.env);
      for (const w of from.env) this.wrote(w.value, w.value);
      this.cwd = from.cwd;
      if (from.positional) this.note(POSITIONAL, "code");
    }
  }

  // Notes a write of NAME=value (or NAME+=value), given as written, judged by its value (Reader.judged).
  private wrote(raw: string, value = raw): void {
    const m = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=([\s\S]*)$/.exec(raw);
    if (m) this.note(m[1]!, judged(m[2]!));
    else if (/^[A-Za-z_]\w*$/.test(value)) this.note(value, "code");
  }

  private note(name: string, kind: Judgement): void {
    this.writes.set(name, [...(this.writes.get(name) ?? []), kind]);
  }

  // Notes the names in arithmetic text, leaving out what its $(...) and backticks hold.
  private counted(text: string): void {
    const bare = text.replace(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`/g, "");
    for (const m of bare.matchAll(/[A-Za-z_]\w*/g)) this.arith.add(m[0]);
    // A positional parameter, whatever follows its name: $1, ${1}, ${1:-0}, ${#1}, ${!1}, $@, ${@:2}, and the last, ${!#}.
    if (/\$(?:\d|[@*]|\{[#!]?(?:\d|[@*])|\{!#)/.test(bare)) this.arith.add(POSITIONAL);
  }

  // Adds the counts of a reader whose text is part of this line, run by this line's shell or one it starts.
  merge(part: Part): void {
    for (const name of part.arith ?? []) this.arith.add(name);
    addSubs(this.subs, part);
  }

  // bash, choice 42: a line with arithmetic that uses a name asks only when it also holds a $( or a backtick that it does
  // not itself read as a command substitution (in single quotes, $'...', escaped, in a quoted here-document or a
  // here-string): code text that could reach a variable and run inside an array index. A value from a command's output or
  // a file is a known limit. The arithmetic is what a bash the reader reads would evaluate, found as it reads: (( )),
  // $(( )), $[ ], for (( )), let, declare -i, [[ ... -eq ... ]] and the like, ${a[i]} and ${x:i:n} outside single quotes,
  // a[i]= assignments, and unset, declare and [[ -v ]] operands with a subscript. Text in single quotes, or given to a
  // program that is not a shell the reader follows (ssh, python -c, grep), is not.
  //
  // Visible code can also be split or escaped so that the text never holds $(, as in X=a[\$\(rm\ x\)] or
  // X=$'a[\x24(rm x)]', so each write the line makes to a name used in arithmetic must also be judged fine (Reader.judged):
  // a plain integer, one $(( )), one command substitution (its output is the known limit), a plain copy of a name that
  // passes in turn, or read, mapfile or readarray of the line's own input or a file. Positional parameters, used in
  // arithmetic or copied, pass unless the line gives them (POSITIONAL). A dynamic setter or a nameref anywhere on the line
  // asks whenever there is arithmetic.
  checkArithmetic(): void {
    if (this.g !== "bash") return;
    const { src } = this;
    if (this.arith.size === 0) return;
    const dollars = src.split("$(").length - 1;
    const ticks = src.split("`").length - 1;
    if (dollars > this.subs.dollars || ticks > this.subs.ticks) throw new Unreadable(MADE);
    if (this.writtenAll || DYNAMIC_SETTER.test(src)) throw new Unreadable(MADE);
    // Follows copies; a copy that comes back to a name already being followed is taken as code, to be safe.
    const hides = (name: string, path: Set<string>): boolean => {
      if (path.has(name)) return true;
      path.add(name);
      const found = (this.writes.get(name) ?? []).some((k) => k === "code" || (k.startsWith("copy:") && hides(k.slice(5), path)));
      path.delete(name);
      return found;
    };
    if ([...this.arith].some((name) => hides(name, new Set()))) throw new Unreadable(MADE);
  }

  // Reads commands up to `stop`.
  sequence(stop: Stop): Part {
    const outer = this.pending;
    if (stop) {
      this.waiting += outer.length;
      this.pending = [];
    }
    const commands: Command[] = [];
    // Compound commands begun here (while, if, ...): whether a pipe feeds each, and what inside reads its input, which a
    // redirect after its done or fi decides.
    const open: { piped: boolean; hungry: Hunger; reads: number }[] = [];
    let hungry = NONE;
    let piped = false;
    let carried = false;
    let literal = false; // PowerShell: the pipe carries only a string written in the line
    const add = (h: Hunger) => {
      const inside = open.at(-1);
      if (inside) inside.hungry = most(inside.hungry, h);
      else hungry = most(hungry, h);
    };
    for (;;) {
      const reads = this.reads.length;
      const r = this.command(stop, carried);
      // A compound command after a pipe takes its input in every command inside it.
      const fed = piped || open.some((o) => o.piped);
      for (let k = 0; k < r.opens; k++) open.push({ piped: fed, hungry: NONE, reads });
      // Choice 38, extended: in PowerShell, a string piped straight into an interpreter is code written in the line, as with -c.
      const written = piped && literal && r.hungry === CODE;
      if (r.hungry && fed && !written) throw new Unreadable(PIPED);
      add(written ? NONE : r.hungry);
      commands.push(...r.commands);
      for (let k = 0; k < r.closes && open.length > 0; k++) {
        const inside = open.pop()!;
        // A here-document, here-string or file after done or fi feeds every command inside (choices 35 and 38).
        if ((r.fed && inside.hungry === SHELL) || (r.piped && inside.hungry)) throw new Unreadable(PIPED);
        if (r.fed) for (const name of this.reads.splice(inside.reads)) this.note(name, "code");
        add(r.replaced ? NONE : inside.hungry);
      }
      if (r.sep === stop) break;
      literal = r.literal && !piped;
      piped = r.sep === "|";
      carried = piped || r.sep === "&&" || r.sep === "||";
    }
    for (const inside of open) hungry = most(hungry, inside.hungry); // a compound with no end, which bash would refuse
    if (stop) {
      if (this.pending.length > 0) throw new Unreadable(HEREDOC); // its body would have to come after the bracket's end
      this.waiting -= outer.length;
      this.pending = outer;
    }
    return { commands, hungry };
  }

  // Reads one command, and the separator after it. `carried`: the line before ended in |, && or ||, so blank lines
  // before this command are skipped, as bash and PowerShell carry on to the next line.
  private command(stop: Stop, carried: boolean): CommandRead {
    const { src, g } = this;
    const words: Word[] = [];
    const nested: Command[] = []; // the commands inside this one: $(...), backticks, brackets
    let start = -1;
    let last = -1;
    let group = false; // this command was a ( ) or { } group, which only redirections may follow
    let groupHungry = NONE;
    let groupReads = -1; // where the reads in this command's group or case begin (Reader.reads)
    let named = false; // after bash's `function`: the name comes next
    let defining: string | undefined; // the name of the function whose body comes next
    let coproc = false; // after bash's `coproc`: a name may come before a group
    let called = false; // after PowerShell's & or .: the next word names the command
    let fed = false; // a here-document or here-string is this command's input
    let input = false; // a file is this command's input
    let copied = false; // <&N or 0<&N copies another file number into the input, which may be the pipe
    let piped = false; // a process substitution, as in `< <(curl x)`, is this command's input
    let substituted = false; // a process substitution is redirected onto any file number of this command
    let other = false; // one is redirected onto a file number other than 0 and 1
    let opens = 0;
    let closes = 0;
    const outerHungry = this.hungry;
    this.hungry = NONE;
    const done = (sep: string) => {
      const own = this.emit(words, start, last, called, fed);
      if (fed && groupReads >= 0) for (const name of this.reads.splice(groupReads)) this.note(name, "code");
      this.merge(own); // the shell texts it gives, read by their own readers
      const subs = this.hungry; // $(...) and backticks read the line's input, not the command's
      this.hungry = outerHungry;
      const hungry = most(own.hungry, groupHungry);
      if ((hungry === SHELL && fed) || (hungry && piped)) throw new Unreadable(PIPED);
      // A process substitution redirected for a shell or an interpreter, or for exec, which keeps it open for later commands:
      // the program may read it as its script (choice 37).
      if (substituted && own.program) throw new Unreadable(PIPED);
      // On a file number other than 0 and 1 of a group, a loop, an if, a case or a function call, the commands inside may
      // read it as a script, as in `{ bash /dev/fd/3; } 3< <(curl x)`. Files 0 and 1 are the input and output, already followed.
      const callee = g === "bash" ? words[assignments(words, src)] : undefined;
      if (other && (group || closes > 0 || (callee && this.functions.has(src.slice(callee.start, callee.end))))) throw new Unreadable(PIPED);
      // A here-document, here-string or file in place of the input: an interpreter reading it runs code written in the line.
      const replaced = (fed || input) && !copied;
      // PowerShell: a command that is only a string or here-string written in the line, with nothing in it made when it runs.
      const literal = g === "powershell" && words.length === 1 && !!words[0]!.single && !words[0]!.dynamic;
      const result = { commands: [...own.commands, ...nested], sep, hungry: most(replaced ? NONE : hungry, subs), opens, closes };
      return { ...result, fed, piped, replaced, literal };
    };
    for (;;) {
      this.space();
      const at = this.i;
      const c = src[at];
      const next = src[at + 1];
      if (c === undefined) {
        if (this.pending.length > 0) throw new Unreadable(HEREDOC); // its end line never came
        if (stop) throw new Unreadable(UNPAIRED);
        return done("");
      }
      const redirected = this.redirection(stop, nested);
      if (redirected) {
        fed ||= redirected === "text";
        input ||= redirected === "input";
        copied ||= redirected === "copy";
        piped ||= redirected === "piped";
        substituted ||= redirected === "procsub" || redirected === "procsub-other" || redirected === "piped";
        other ||= redirected === "procsub-other";
        if (start < 0) start = at;
        last = this.i;
        continue;
      }
      // The end of a case arm: ;; or ;& or ;;&, or esac where a command would start.
      if (stop === ";;" && ((c === ";" && (next === ";" || next === "&")) || (start < 0 && words.length === 0 && this.looking(/(?=esac(?![^\s;&|)]))/y)))) {
        if (c === ";") this.i += src.startsWith(";;&", at) ? 3 : 2;
        return done(";;");
      }
      if (c === "\n" || (c === ";" && g !== "cmd")) {
        if (c === "\n" && this.waiting > 0) throw new Unreadable(HEREDOC);
        this.i++;
        if (c === "\n") nested.push(...this.bodies());
        if (c === "\n" && carried && g !== "cmd" && start < 0 && !group) continue;
        return done(c);
      }
      if (c === "&" || c === "|") {
        const two = src.slice(at, at + 2);
        if (two === "&&" || two === "||" || (two === "|&" && g === "bash")) {
          this.i += 2;
          return done(two === "|&" ? "|" : two);
        }
        this.i++;
        if (c === "&" && g === "powershell" && words.length === 0) {
          called = true; // the call operator, as in `& 'name'`
          continue;
        }
        return done(c);
      }
      if (c === ")" && (stop === ")" || g !== "cmd")) {
        if (stop !== ")") throw new Unreadable(UNPAIRED);
        this.i++;
        return done(")");
      }
      const first: boolean = words.length === 0 && !group;
      if (c === "}" && (g === "powershell" || (g === "bash" && first && this.ends(next, stop)))) {
        if (stop !== "}") throw new Unreadable(UNPAIRED);
        this.i++;
        return done("}");
      }
      // Arithmetic, `(( ... ))` on its own or in `for (( ...; ...; ... ))`: only its $(...) and backticks hold commands.
      const arithmeticFor = words.length === 1 && src.slice(words[0]!.start, words[0]!.end) === "for";
      // Otherwise, ( (...) ...) is a subshell, as bash reads it.
      if (c === "(" && next === "(" && g === "bash" && (first || arithmeticFor) && this.arithmeticAhead(at + 2)) {
        this.i += 2;
        this.arithmetic(nested);
        group ||= first;
        last = this.i;
        continue;
      }
      if (c === "(" && g === "bash") {
        // A function's definition, `name()`: its body is read as the next command.
        if (words.length <= 1 && !group && this.looking(/\(\s*\)/y)) {
          if (words[0]) defining = src.slice(words[0].start, words[0].end);
          words.length = 0;
          start = -1;
          continue;
        }
        if (!first) throw new Unreadable(MISPLACED);
      }
      if ((c === "(" && g !== "powershell" && first) || (c === "{" && g === "bash" && first && /[ \t\n]/.test(next ?? ""))) {
        this.i++;
        if (groupReads < 0) groupReads = this.reads.length;
        const part = this.sequence(c === "(" ? ")" : "}");
        nested.push(...part.commands);
        // A function's body runs when the function is called, with the caller's input (choice 37).
        if (defining !== undefined) {
          this.functions.set(defining, part.hungry);
          this.note(POSITIONAL, "code"); // its calls give it positional parameters
        }
        else groupHungry = most(groupHungry, part.hungry);
        defining = undefined;
        group = true;
        last = this.i;
        continue;
      }
      // PowerShell's dot-sourcing, as in `. .\setup.ps1`; with no blank it can be followed by a bracket, a variable or a
      // quote, as in `.$c`, which name the command too.
      const quote = PS_SINGLE.has(next ?? "") || PS_DOUBLE.has(next ?? "");
      if (c === "." && g === "powershell" && words.length === 0 && (/[ \t($@{]/.test(next ?? "") || quote)) {
        this.i++;
        called = true;
        continue;
      }
      const w = this.word(stop, nested);
      if (group) throw new Unreadable(MISPLACED);
      const raw = src.slice(w.start, w.end);
      if (g === "bash" && words.length === 0) {
        if (named) {
          named = false;
          defining = raw;
          continue;
        }
        if (coproc) {
          coproc = false;
          const name = /[ \t]*[{(]/y; // `coproc NAME { ...; }`: the name of a coprocess run from a group
          name.lastIndex = this.i;
          if (name.test(src)) continue;
        }
        if (raw === "case") {
          if (groupReads < 0) groupReads = this.reads.length;
          groupHungry = most(groupHungry, this.cases(nested));
          group = true;
          last = this.i;
          continue;
        }
        if (raw === "coproc") coproc = true;
        if (raw === "function") named = true;
        if (OPENS.has(raw)) opens++;
        if (CLOSES.has(raw)) closes++;
        if (raw === "coproc" || raw === "function" || RESERVED.has(raw)) continue;
      }
      // After & or ., PowerShell runs whatever the word holds when the line runs (choice 37); a script block is read. A
      // Windows system folder's variable with a literal path after it names the program at the path's end.
      if (called && words.length === 0 && w.dynamic) {
        if (!this.systemFolder(raw)) throw new Unreadable(NAMED);
        w.dynamic = false;
      }
      if (g === "powershell" && raw === "--%") {
        this.verbatim(words);
        last = this.i;
        continue;
      }
      if (start < 0) start = w.start;
      words.push(w);
      last = w.end;
    }
  }

  private emit(words: Word[], start: number, last: number, called: boolean, fed: boolean): Part {
    const { src, g } = this;
    const k = g === "bash" ? assignments(words, src) : 0;
    const own = g === "bash" ? words.slice(k) : g === "powershell" ? psUnassigned(words, src) : cmdOwn(words);
    const vars = [...this.exported, ...words.slice(0, k)];
    for (const w of words.slice(0, k)) {
      this.subscript(src.slice(w.start, w.end)); // a[i]=x: the subscript is arithmetic
      this.wrote(src.slice(w.start, w.end));
    }
    if (own.length === 0) {
      this.exported.push(...words.slice(0, k));
      return { commands: [], hungry: NONE };
    }
    // PowerShell: an element that is exactly one string or here-string, as in `$x = 'format'` or `'x' | Out-File f`, is a
    // value, not a command; only & or . would run it. Its $(...) are read all the same. Anything after the string, as in
    // `'x' + (...)` or `'x'.Replace(...)`, makes it an expression, whose brackets are read as commands.
    if (g === "powershell" && !called && own.length === 1 && own[0]!.single) return { commands: [], hungry: NONE };
    const name = own[0]!.value;
    const args = own.slice(1);
    if (g === "bash") this.settings(name, args, vars, fed);
    // A cd behind a wrapper (builtin cd, command cd) leaves the shell somewhere the check does not follow.
    const lost = () => {
      this.cwd = ANYWHERE;
    };
    const part = expand(own, src.slice(start, last), src, g, { inner: false, vars, functions: this.functions, cwd: this.cwd, lost });
    return { ...part, program: part.program || name === "exec" }; // exec keeps its redirections open for the commands after it
  }

  // What a bash command sets for the rest of the line: variables (export, declare, typeset, readonly, local), aliases, and
  // the folder (cd, pushd, popd). A function exported for child shells is unreadable: a child's `bash -c f` would run it,
  // and its reader would not know f (choice 37).
  private settings(name: string, args: Word[], vars: Word[], fed: boolean): void {
    // builtin and command run the builtin after their options (command -v and -V only name it), which sets the same.
    if (name === "builtin" || name === "command") {
      const k = args.findIndex((w) => !w.value.startsWith("-"));
      const naming = name === "command" && args.slice(0, Math.max(k, 0)).some((w) => /^-\w*[vV]/.test(w.value));
      if (k >= 0 && !naming) this.settings(args[k]!.value, args.slice(k + 1), vars, fed);
    }
    const options = args.filter((w) => w.value.startsWith("-")).map((w) => w.value.slice(1)).join("");
    // mapfile's and readarray's -C runs its callback text as code.
    if ((name === "mapfile" || name === "readarray") && args.some((w) => /^-\w*C/.test(w.value))) throw new Unreadable(FOLLOW);
    if (DECLARERS.includes(name)) {
      if ((name === "export" && options.includes("f")) || (name !== "export" && options.includes("f") && options.includes("x"))) {
        throw new Unreadable(FOLLOW);
      }
      this.exported.push(...args.filter((w) => !w.value.startsWith("-") && w.value.includes("=")));
    }
    if (NAMES.has(name)) this.names(name, args);
    this.arithmeticWords(name, args, options);
    this.writtenBy(name, args, fed);
    if (name === "alias") for (const a of args) if (a.value.indexOf("=") > 0) this.functions.set(a.value.slice(0, a.value.indexOf("=")), SHELL);
    if (MOVES.has(name)) this.cwd = most(this.cwd, this.moved(name, args, vars));
  }

  // The names a bash command reads as arithmetic (Reader.checkArithmetic): let's words, the names declare -i (and typeset
  // and local -i) makes integers, the words of [[ ... -eq ... ]] (and -ne, -lt, -le, -gt, -ge), and an array subscript in
  // an operand of unset, declare and the like, or of [[ (as in [[ -v a[i] ]]).
  private arithmeticWords(name: string, args: Word[], options: string): void {
    const raw = (w: Word) => this.src.slice(w.start, w.end);
    if (TYPED.includes(name) && options.includes("i")) {
      for (const w of args) if (!w.value.startsWith("-")) this.counted(w.value.split("=")[0]!);
    }
    if (name === "let") for (const w of args) this.counted(raw(w));
    if (name === "[[" && args.some((w) => /^-(eq|ne|lt|le|gt|ge)$/.test(w.value))) for (const w of args) this.counted(raw(w));
    // A builtin may read any of its words as a variable's name, subscript included (printf -v, read, getopts, mapfile,
    // wait -p, test -v, a nameref's target), so a subscript in any of them is counted, to be safe.
    if (BUILTINS.has(name)) for (const w of args) this.subscript(w.value);
  }

  // The writes a bash command makes to names, for arithmetic (Reader.checkArithmetic): NAME=value operands of the
  // declarers, judged by their value; the readers' names (REPLY or MAPFILE when none is given), and select's REPLY, code
  // when a here-document or here-string on the line feeds them (`fed`, or their loop's or group's: Reader.reads), else
  // fine; getopts, which writes an option letter, and OPTARG, always code: it comes from the words after the name or the
  // positional parameters, either of which the line may give; set with an operand, which gives the positional parameters
  // (POSITIONAL); printf -v and select's name, which take text the line gives; and a for loop, whose name takes each of
  // its words, judged one by one.
  private writtenBy(name: string, args: Word[], fed: boolean): void {
    const raw = (w: Word) => this.src.slice(w.start, w.end);
    const operands = args.filter((w) => !w.value.startsWith("-"));
    const read = (variable: string) => {
      if (fed) this.note(variable, "code");
      else this.reads.push(variable);
    };
    if (DECLARERS.includes(name)) for (const w of operands) if (w.value.includes("=")) this.wrote(raw(w));
    if (READERS.includes(name)) for (const variable of readerNames(name, args)) read(variable);
    if (name === "getopts") {
      const named = args[0]?.value === "--" ? args[2] : args[1];
      if (named) this.note(named.value, "fine");
      this.note("OPTARG", "code"); // from words after the name or the positional parameters, either of which the line may give
    }
    if (name === "set" && setsPositional(args)) this.note(POSITIONAL, "code");
    if (name === "select" && operands[0]) {
      this.note(operands[0].value, "code");
      read("REPLY");
    }
    const target = name === "printf" ? printfTarget(args) : undefined;
    if (target) this.note(target.name, "code");
    if (name === "for" && args[1]?.value === "in") for (const w of args.slice(2)) this.note(args[0]!.value, judged(raw(w)));
  }

  // An array subscript at the start of a word, or after a NAME= there, as in a[i]=x, unset 'a[i]' or declare -n r='a[i]',
  // is arithmetic.
  private subscript(word: string): void {
    const m = /^(?:[A-Za-z_]\w*=)?[A-Za-z_]\w*\[([^\]]*)\]/.exec(word);
    if (m) this.counted(m[1]!);
  }

  // The variables a name-setting command writes (NAMES): each name argument, after its quotes are taken off. A name made
  // when the line runs, or a nameref (declare -n), may write any variable.
  private names(name: string, args: Word[]): void {
    const note = (w: Word, value = w.value) => {
      const head = this.src.slice(w.start, w.end).split("=")[0]!;
      if (/[$`]/.test(head) || (w.dynamic && !value.includes("="))) this.writtenAll = true;
      else this.written.add(/^[A-Za-z_]\w*/.exec(value)?.[0] ?? value);
    };
    if (name === "printf") {
      const target = printfTarget(args);
      if (target) note(target.word, target.name);
      return;
    }
    for (let k = 0; k < args.length; k++) {
      const w = args[k]!;
      if (!w.value.startsWith("-") || name === "let") note(w);
      else if (/n/.test(w.value) && TYPED.includes(name)) this.writtenAll = true; // a nameref
      else if (w.value.length === 2 && (READER_VALUES[name] ?? "").includes(w.value[1]!)) k++;
    }
  }

  // Whether a PowerShell word is a Windows system folder's variable ($env:SystemRoot, $env:windir, $env:ProgramFiles,
  // ${env:ProgramFiles(x86)} or $env:ProgramW6432) followed by a literal path, as in "$env:SystemRoot\System32\x.exe", so
  // the command is the path's last part. Not if the path holds .., nor if the line touches the Env: drive in any way other
  // than reading $env:..., nor if it sets the variable, as by `$env:SystemRoot = ...`.
  private systemFolder(raw: string): boolean {
    const m = /^"?(?:\$env:(systemroot|windir|programfiles|programw6432)|\$\{env:(programfiles\(x86\))\})((?:\\[^\\$`"'(){}@;&|]+)+)"?$/i.exec(raw);
    if (!m || m[3]!.split("\\").includes("..")) return false;
    const name = (m[1] ?? m[2])!.replace(/[()]/g, "\\$&");
    return !/(?<![$\\{])env:/i.test(this.src) && !new RegExp(`\\$\\{?env:${name}\\}?\\s*=`, "i").test(this.src);
  }

  // Whether `name` is set anywhere on the line, in any way: by a name-setting command read so far (NAMES), by a name made
  // when the line runs or a nameref anywhere, as a plain word anywhere (perhaps split by quotes, as in H"OME"), by
  // ${NAME:=...} or ${NAME=...}, or through env, sudo or an export the line's shell inherits.
  private set(name: string, vars: Word[] = []): boolean {
    return (
      this.writtenAll ||
      this.written.has(name) ||
      DYNAMIC_SETTER.test(this.src) ||
      plainName(name).test(this.src) ||
      new RegExp(`\\$\\{${name}:?=`).test(this.src) ||
      [...vars, ...this.exported].some((v) => v.value.startsWith(`${name}=`))
    );
  }

  // Where a cd, pushd or popd may leave the shell. Its options are skipped up to --, and the target is tidied as paths are
  // (ownInput), so `cd -- /dev` and `cd /./` are read for what they are. These leave the shell anywhere: an option the check
  // does not know; the folder stack (`cd -`, popd, pushd +N); a ~ form other than ~ and ~/... (~- and ~+ are the folders
  // before and now, ~user another's home); and HOME, CDPATH or PWD set anywhere on the line.
  private moved(name: string, args: Word[], vars: Word[]): Cwd {
    const set = (variable: string) => this.set(variable, vars);
    let target: Word | undefined;
    for (let k = 0; k < args.length; k++) {
      const value = args[k]!.value;
      if (value === "--") {
        target = args[k + 1];
        break;
      }
      if (/^-[LPe@]+$/.test(value) || (name !== "cd" && value === "-n")) continue; // cd's -L, -P, -e, -@; pushd's and popd's -n
      if (value.startsWith("-") || value.startsWith("+")) return ANYWHERE; // `cd -`, the folder stack, or an option not known
      target = args[k];
      break;
    }
    if (name === "popd" || (name === "pushd" && !target)) return ANYWHERE;
    if (!target) return set("HOME") ? ANYWHERE : KNOWN; // cd alone goes home
    const home = target.value === "~" || target.value.startsWith("~/");
    if (target.value.startsWith("~") && (!home || set("HOME"))) return ANYWHERE;
    if (target.dynamic || ownInput(target.value, this.cwd)) return ANYWHERE;
    const relative = !/^[/~]/.test(target.value);
    // From a folder not known, found through CDPATH, or climbed from a PWD set on the line.
    if (relative && (this.cwd !== KNOWN || set("CDPATH") || set("PWD"))) return ANYWHERE;
    if (target.value.startsWith("/")) return tidied(target.value).length === 0 ? ROOT : KNOWN;
    return target.value.split("/").includes("..") ? ROOT : KNOWN;
  }

  // bash's `case WORD in [(]PATTERN[|PATTERN]...) COMMANDS ;; ... esac`, after its `case`: the word and the patterns are words,
  // whose $(...) are read, and each arm's commands are read up to its ;; (or ;& or ;;&) or the esac. Returns what in the
  // arms reads the case's input.
  private cases(nested: Command[]): Hunger {
    const { src } = this;
    const blanks = () => {
      for (this.space(); src[this.i] === "\n"; this.space()) {
        if (this.waiting > 0) throw new Unreadable(HEREDOC);
        this.i++;
        nested.push(...this.bodies());
      }
    };
    const word = () => {
      const from = this.i;
      const w = this.word(";;", nested);
      if (this.i === from) throw new Unreadable(src[from] === undefined ? UNPAIRED : MISPLACED);
      return src.slice(w.start, w.end);
    };
    this.space();
    word(); // the word matched
    blanks();
    if (word() !== "in") throw new Unreadable(UNPAIRED);
    let hungry = NONE;
    for (;;) {
      blanks();
      if (this.looking(/esac(?![^\s;&|)])/y)) return hungry;
      if (src[this.i] === undefined) throw new Unreadable(UNPAIRED);
      if (src[this.i] === "(") this.i++;
      for (;;) {
        this.space();
        if (src[this.i] === ")") break;
        if (src[this.i] === "|") this.i++;
        else word(); // a pattern
      }
      this.i++;
      const arm = this.sequence(";;");
      nested.push(...arm.commands);
      hungry = most(hungry, arm.hungry);
    }
  }

  // Skips blanks, escaped new lines and comments.
  private space(): void {
    const { src, g } = this;
    for (;;) {
      const c = src[this.i];
      if (c === " " || c === "\t" || c === "\r") this.i++;
      else if (c === this.escape && src[this.i + 1] === "\n") this.i += 2;
      else if (c === "#" && g !== "cmd") {
        const end = src.indexOf("\n", this.i);
        this.i = end < 0 ? src.length : end;
      } else if (g === "powershell" && src.startsWith("<#", this.i)) {
        const close = src.indexOf("#>", this.i + 2);
        if (close < 0) throw new Unreadable(UNPAIRED);
        this.i = close + 2;
      } else return;
    }
  }

  private ends(c: string | undefined, stop: Stop): boolean {
    if (c === undefined || " \t\r\n".includes(c)) return true;
    if (this.g === "bash") return ";&|()<>".includes(c);
    if (this.g === "powershell") return ";&|)}<>".includes(c);
    return "&|<>".includes(c) || (c === ")" && stop === ")");
  }

  // Whether `re` (sticky) matches here; if so, moves past it.
  private looking(re: RegExp): boolean {
    re.lastIndex = this.i;
    if (!re.test(this.src)) return false;
    this.i = re.lastIndex;
    return true;
  }

  // Reads a redirection if one starts here, and leaves it out of the command's words (choice 32). A here-document or
  // here-string is left out the same way (choice 35). Says what it was: "text" for a here-document or here-string on the
  // input, "input" for a file read as the input, "copy" for another file number copied into the input (<&N, 0<&N), which
  // may be the pipe, and "file" for any other. Only file number 0, written or left out, is the input.
  private redirection(stop: Stop, nested: Command[]): Redirect {
    const { src, g } = this;
    if (g === "bash" && /[<>]\(/y.test(src.slice(this.i, this.i + 2))) return false; // a process substitution, read as a word
    const re =
      g === "bash" ? /(\d*)(&>>|&>|>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)/y : g === "powershell" ? /([*\d]?)(>>|>|<)(&\d)?/y : /(\d?)(>>|>|<)(&\d)?/y;
    re.lastIndex = this.i;
    const m = re.exec(src);
    if (!m) return false;
    const op = m[2]!;
    const here = op.startsWith("<<");
    const onInput = m[1] === "" || m[1] === "0";
    this.i = re.lastIndex;
    if (g === "bash" && src[this.i] === "(") throw new Unreadable(PROCESS);
    if (m[3]) return op === "<" && onInput ? "copy" : "file"; // 2>&1 and the like, which name no file
    while (src[this.i] === " " || src[this.i] === "\t") this.i++;
    const substituted = g === "bash" && /[<>]\(/y.test(src.slice(this.i, this.i + 2)); // as in `done < <(ls)`
    if (!substituted && this.ends(src[this.i], stop)) throw new Unreadable(here ? HEREDOC : NO_FILE);
    // A here-string's word is read as any word is, its $(...) and backticks included unless it is in single quotes.
    const w = this.word(stop, nested);
    if (op === "<&") return onInput ? "copy" : "file";
    // A command's output in place of the input, as in `sh < <(curl x)`: a shell or an interpreter there runs it. On another
    // file number, as in `bash /dev/fd/3 3< <(curl x)`, it can still be read as one's script (Reader.command).
    if (w.fed) {
      if (onInput && (op === "<" || op === "<>")) return "piped";
      const fd = m[1] || (op.startsWith("<") ? "0" : "1");
      return fd === "0" || fd === "1" ? "procsub" : "procsub-other";
    }
    // A quoted end word, as in <<'EOF', <<"EOF" or <<\EOF, keeps bash from expanding the body (bash manual, "Here Documents").
    if (op !== "<<<" && here) this.pending.push({ end: w.value, strip: op === "<<-", expands: !/['"\\]/.test(src.slice(w.start, w.end)) });
    if (here) return onInput ? "text" : "file";
    // A file in place of the command's input; not its own input under another name, nor a file known only when it runs.
    const replaces = (op === "<" || op === "<>") && onInput && !takesInput(w, this.cwd);
    return replaces ? "input" : "file";
  }

  // Reads the bodies of the here-documents begun on the line just ended, and returns the commands in those bash expands.
  private bodies(): Command[] {
    const out: Command[] = [];
    for (const doc of this.pending) {
      const lines: string[] = [];
      for (;;) {
        let line = this.line(doc.strip);
        // In a body bash expands, a line ending in an unescaped backslash is joined to the next before the end line is
        // looked for, so `E\` then `OF` ends a body ended by EOF (tried in bash 5.2).
        while (doc.expands && (line.length - line.replace(/\\+$/, "").length) % 2 === 1) line = line.slice(0, -1) + this.line(doc.strip);
        if (line === doc.end) break;
        lines.push(line);
      }
      if (doc.expands) {
        const reader = new Reader(lines.join("\n"), "bash");
        out.push(...reader.expansions());
        this.hungry = most(this.hungry, reader.hungry);
        this.merge({ commands: [], hungry: NONE, arith: [...reader.arith], subs: reader.subs }); // run by this line's shell
      }
    }
    this.pending = [];
    return out;
  }

  // One line of a here-document's body, without its new line.
  private line(strip: boolean): string {
    const { src } = this;
    if (this.i >= src.length) throw new Unreadable(HEREDOC); // its end line never came
    const newline = src.indexOf("\n", this.i);
    const line = src.slice(this.i, newline < 0 ? src.length : newline);
    this.i = newline < 0 ? src.length : newline + 1;
    return strip ? line.replace(/^\t+/, "") : line;
  }

  // The commands in the text of a here-document or here-string the shell expands: those in its $(...) and, in bash, its
  // backticks, as inside double quotes.
  expansions(): Command[] {
    const { src, g } = this;
    const nested: Command[] = [];
    while (this.i < src.length) {
      const c = src[this.i];
      if (c === this.escape) this.i += 2;
      else if (g === "bash" && c === "$") this.dollar(nested, true);
      else if (g === "bash" && c === "`") this.backtick(nested);
      else if (g === "powershell" && c === "$" && src[this.i + 1] === "(") {
        this.i += 2;
        this.inner(")", nested);
      } else this.i++;
    }
    return nested;
  }

  // Reads the commands in a bracket inside a word.
  private inner(stop: Stop, nested: Command[]): void {
    const part = this.sequence(stop);
    nested.push(...part.commands);
    this.hungry = most(this.hungry, part.hungry);
  }

  // PowerShell's stop-parsing token: the rest of the line, up to a new line or a pipe, goes to the program as written
  // (about_Parsing), and the program's own reading takes the double quotes off.
  private verbatim(words: Word[]): void {
    const re = /[ \t]*([^\s|]+)/y;
    for (;;) {
      re.lastIndex = this.i;
      const m = re.exec(this.src);
      if (!m) return;
      this.i = re.lastIndex;
      words.push({ value: m[1]!.replace(/"/g, ""), start: this.i - m[1]!.length, end: this.i, dynamic: false, shape: "" });
    }
  }

  // Reads one word: its value has the quotes taken off, and the commands inside it are added to `nested`.
  private word(stop: Stop, nested: Command[]): Word {
    const { src, g } = this;
    const start = this.i;
    const outer = this.dynamic;
    this.dynamic = false;
    let value = "";
    let shape = "";
    let parts = 0;
    let string = false; // PowerShell: the word's first part is a string or here-string
    let fed = false;
    if (g === "powershell") this.psCode += " ";
    // bash's process substitution, <(...) or >(...): its commands are read as in $(...), and the word is a file they feed.
    // Those in >(...) read what the command writes there, so a shell or an interpreter among them runs it.
    if (g === "bash" && /[<>]\(/y.test(src.slice(start, start + 2))) {
      const into = src[start] === ">";
      this.i += 2;
      const part = this.sequence(")");
      if (into && part.hungry) throw new Unreadable(PIPED);
      nested.push(...part.commands);
      if (!into) this.hungry = most(this.hungry, part.hungry);
      this.dynamic = fed = true;
      value = src.slice(start, this.i);
      shape = "\0";
    }
    while (!this.ends(src[this.i], stop)) {
      const c = src[this.i]!;
      if (parts++ === 0) {
        const quote = (k: number) => PS_SINGLE.has(src[k] ?? "") || PS_DOUBLE.has(src[k] ?? "");
        const here = c === "@" && quote(this.i + 1) && /^[ \t]*\n/.test(src.slice(this.i + 2, src.indexOf("\n", this.i) + 1));
        string = quote(this.i) || here;
      }
      if (c === this.escape) {
        const n = src[this.i + 1];
        this.i += n === undefined ? 1 : 2;
        value += n === "\n" ? "" : (n ?? c);
        shape += "\0";
        if (g === "powershell") this.psCode += n ?? "";
      } else if (g === "bash") {
        shape += "'\"$`".includes(c) ? "\0" : c;
        value += this.bashPart(nested);
      } else value += g === "powershell" ? this.psPart(nested) : this.cmdPart();
    }
    const word: Word = { value, start, end: this.i, dynamic: this.dynamic, shape, single: g === "powershell" && parts === 1 && string, fed };
    this.dynamic = outer;
    if (g === "powershell" && PS_FOLLOW_TEXT.test(src.slice(start, this.i))) throw new Unreadable(FOLLOW);
    return word;
  }

  private bashPart(nested: Command[]): string {
    const c = this.src[this.i]!;
    if (c === "'") return this.closed("'");
    if (c === '"') return this.bashDouble(nested);
    if (c === "$") return this.dollar(nested, false);
    if (c === "`") return this.backtick(nested);
    this.i++;
    return c;
  }

  private psPart(nested: Command[]): string {
    const { src } = this;
    const from = this.i;
    const c = src[from]!;
    const n = src[from + 1];
    // Each part also goes into the line's code text (choice 39), strings as '' and brackets around their own code.
    const string = (value: string) => ((this.psCode += "''"), value);
    if (PS_SINGLE.has(c)) return string(this.psQuoted(PS_SINGLE));
    if (PS_DOUBLE.has(c)) return string(this.psQuoted(PS_DOUBLE, nested));
    if (c === "@" && this.looking(HERE_STRING)) return string(this.psHere(n!, nested));
    if (c === "(" || ((c === "$" || c === "@") && n === "(")) {
      this.i += c === "(" ? 1 : 2;
      this.psCode += src.slice(from, this.i);
      this.inner(")", nested);
      this.psCode += ")";
      this.dynamic = true;
      return src.slice(from, this.i);
    }
    if (c === "{" || (c === "@" && n === "{")) {
      this.i += c === "{" ? 1 : 2;
      this.psCode += src.slice(from, this.i);
      this.inner("}", nested);
      this.psCode += "}";
      return src.slice(from, this.i);
    }
    if (c === "$" && n === "{") {
      this.psCode += "$v";
      return this.psBraced();
    }
    if (c === "$" && /[\w:?^$]/.test(n ?? "")) this.dynamic = true;
    this.i++;
    this.psCode += c;
    return c;
  }

  // PowerShell's reach into .NET (choice 39), read over the line's code with its strings taken out. A static member call
  // [Type]::Member is allowed only for the types and members in DOTNET_READS, which only read or compute.
  dotnet(): void {
    if (this.g !== "powershell") return;
    const code = this.psCode.toLowerCase();
    if (PS_DOTNET.test(code)) throw new Unreadable(FOLLOW);
    // The type in the [...] that ends at `at`, in lower case, without blanks or System.
    const typeBefore = (at: number) => {
      let depth = 0;
      let from = at;
      for (; from >= 0; from--) {
        if (code[from] === "]") depth++;
        if (code[from] === "[" && --depth === 0) break;
      }
      return code.slice(from + 1, at).replace(/\s+/g, "").replace(/^system\./, "");
    };
    // A string cast to a type, as in [type]'ScriptBlock', asks unless the type is a plain value (STRING_CASTS).
    for (const m of code.matchAll(/\]\s*''/g)) if (!STRING_CASTS.has(typeBefore(m.index))) throw new Unreadable(FOLLOW);
    for (const m of code.matchAll(/::/g)) {
      let at = m.index - 1;
      while (code[at] === " ") at--;
      const member = /^\s*([\w]+)/.exec(code.slice(m.index + 2))?.[1];
      if (code[at] === "]") {
        if (!member || !readsOnly(typeBefore(at), member)) throw new Unreadable(FOLLOW);
        continue;
      }
      // A provider path, as in FileSystem::C:\x, is allowed; a type held in a variable ($t::) or made some other way is not.
      const name = /([$\w.\\-]+)$/.exec(code.slice(0, at + 1))?.[1] ?? "";
      if (!/^[\w.\\-]+$/.test(name) || name.startsWith("$")) throw new Unreadable(FOLLOW);
    }
  }

  // cmd's quotes have no escapes inside; ^ escapes outside them.
  private cmdPart(): string {
    const c = this.src[this.i]!;
    if (c === '"') return this.closed('"');
    this.i++;
    return c;
  }

  // A quote whose text is taken as it is, up to the same quote mark.
  private closed(quote: string): string {
    const close = this.src.indexOf(quote, this.i + 1);
    if (close < 0) throw new Unreadable(UNCLOSED);
    const value = this.src.slice(this.i + 1, close);
    this.i = close + 1;
    return value;
  }

  // bash's double quotes: a backslash keeps only $ ` " \ and a new line (bash manual, "Double Quotes").
  private bashDouble(nested: Command[]): string {
    const { src } = this;
    this.i++;
    let value = "";
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNCLOSED);
      if (c === '"') {
        this.i++;
        return value;
      }
      const n = src[this.i + 1];
      if (c === "\\" && n !== undefined && '$`"\\\n'.includes(n)) {
        value += n === "\n" ? "" : n;
        this.i += 2;
      } else if (c === "$") value += this.dollar(nested, true);
      else if (c === "`") value += this.backtick(nested);
      else {
        value += c;
        this.i++;
      }
    }
  }

  // bash's $ forms that hold code or quotes: $(...), $((...)), ${...}, $'...' and $"..."; a $ before a name is a variable;
  // any other $ is an ordinary character.
  private dollar(nested: Command[], quoted: boolean): string {
    const { src } = this;
    const from = this.i;
    const n = src[from + 1];
    if (n === "(" || n === "{") this.dynamic = true;
    if (n === "(") {
      this.subs.dollars++;
      // $(( ... )) is arithmetic only if its bracket closes with )), as bash reads it; else it is $( (...) ... ).
      if (src[from + 2] === "(" && this.arithmeticAhead(from + 3)) {
        this.i = from + 3;
        this.arithmetic(nested);
        return src.slice(from, this.i);
      }
      this.i = from + 2;
      this.inner(")", nested);
      return src.slice(from, this.i);
    }
    if (n === "{") {
      this.i = from + 2;
      this.braces(nested);
      return src.slice(from, this.i);
    }
    // $[ ... ]: the old form of $(( ... )).
    const old = n === "[" ? src.indexOf("]", from + 2) : -1;
    if (old >= 0) {
      this.counted(src.slice(from + 2, old));
      this.i = old + 1;
      this.dynamic = true;
      return src.slice(from, this.i);
    }
    if (n === "'" && !quoted) return this.ansi();
    if (n === '"' && !quoted) {
      this.i++;
      return this.bashDouble(nested);
    }
    if (/[\w@*#?$!-]/.test(n ?? "")) this.dynamic = true; // $name, $1, $@ and bash's other special parameters
    this.i++;
    return "$";
  }

  // Whether the text from `at`, just after (( or $((, is arithmetic: whether its bracket closes with )) rather than ) and
  // something else, as bash decides. Looked at before the text is read, so that it is read only as one or the other:
  // reading it one way and then again the other would take time doubling with each level and count what it holds twice.
  // This look rescans the text once per level of nesting, which the stack limit bounds. Escapes and single quotes are
  // skipped. A $(, ${ or backtick met first, in double quotes or not, counts as arithmetic, as bash reads each as one piece
  // whose brackets this count would get wrong; arithmetic() asks when bash would have read a subshell after all. A line
  // that ends first is left to the reading to call unpaired.
  private arithmeticAhead(at: number): boolean {
    const { src } = this;
    const piece = (k: number) => src[k] === "`" || (src[k] === "$" && (src[k + 1] === "(" || src[k + 1] === "{"));
    let depth = 0;
    for (let k = at; k < src.length; k++) {
      const c = src[k]!;
      if (c === "\\") k++;
      else if (piece(k)) return true;
      else if (c === "'") {
        const end = src.indexOf("'", k + 1);
        k = end < 0 ? src.length : end;
      } else if (c === '"') {
        for (k++; k < src.length && src[k] !== '"'; k++) {
          if (src[k] === "\\") k++;
          else if (piece(k)) return true;
        }
      } else if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) return src[k + 1] === ")";
    }
    return true;
  }

  // (( ... )) or $(( ... )), known to be arithmetic (Reader.arithmeticAhead): its only commands are in its own $(...) and
  // backticks.
  private arithmetic(nested: Command[]): void {
    const { src } = this;
    const from = this.i;
    let depth = 0;
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNPAIRED);
      if (c === ")" && depth === 0) {
        if (src[this.i + 1] !== ")") throw new Unreadable(UNPAIRED);
        this.counted(src.slice(from, this.i));
        this.i += 2;
        return;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "$") this.dollar(nested, true);
      else if (c === "`") this.backtick(nested);
      else this.i++;
    }
  }

  // ${...}: a variable, whose default can hold a command, as in ${x:-$(rm y)}.
  private braces(nested: Command[]): void {
    const { src } = this;
    const from = this.i;
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNPAIRED);
      if (c === "}") {
        // Arithmetic bash does here: an array's subscript, as in ${a[i]}, and a substring's offset and length, as in
        // ${x:i:n} (not ${x:-...}, ${x:=...}, ${x:+...} or ${x:?...}).
        const inside = src.slice(from, this.i);
        const parts = /^[#!]?(?:[A-Za-z_]\w*|\d+|[@*])(?:\[([^\]]*)\])?(?::(?![-=+?])([\s\S]*))?$/.exec(inside);
        if (parts?.[1]) this.counted(parts[1]);
        if (parts?.[2]) this.counted(parts[2]);
        // ${!X}, ${!X:-...} and the like read X's value as a variable's name, and bash evaluates a subscript in it as
        // arithmetic, so X counts as used there; ${!prefix*}, ${!prefix@} and ${!a[@]} only list names or keys.
        const indirect = /^!([A-Za-z_]\w*|\d+|[@*#])([\s\S]*)$/.exec(inside); // ${!#} is the last positional parameter
        if (indirect && !/^([@*]|\[[@*]\])$/.test(indirect[2]!)) this.arith.add(/^[A-Za-z_]/.test(indirect[1]!) ? indirect[1]! : POSITIONAL);
        // ${X:=...} and ${X=...} write X as they expand: text the line gives.
        const assigned = /^([A-Za-z_]\w*):?=/.exec(inside);
        if (assigned) this.note(assigned[1]!, "code");
        this.i++;
        return;
      }
      if (c === "\\") this.i += 2;
      else if (c === "'") this.closed("'");
      else if (c === '"') this.bashDouble(nested);
      else if (c === "$") this.dollar(nested, true);
      else if (c === "`") this.backtick(nested);
      else this.i++;
    }
  }

  // bash's $'...', whose escapes are read as bash reads them, so $'\x72m' is rm (bash manual, "ANSI-C Quoting").
  private ansi(): string {
    const { src } = this;
    this.i += 2;
    let value = "";
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNCLOSED);
      if (c === "'") {
        this.i++;
        return value;
      }
      if (c !== "\\") {
        value += c;
        this.i++;
        continue;
      }
      // \xHH, \uHHHH, \UHHHHHHHH and \nnn take up to two, four, eight and three digits, \cx is control-x (the manual's own).
      const re = /x([\da-fA-F]{1,2})|u([\da-fA-F]{1,4})|U([\da-fA-F]{1,8})|([0-7]{1,3})|c([\s\S])|([\s\S])/y;
      re.lastIndex = this.i + 1;
      const m = re.exec(src);
      if (!m) throw new Unreadable(UNCLOSED);
      this.i = re.lastIndex;
      const hex = m[1] ?? m[2] ?? m[3];
      if (hex) value += codePoint(parseInt(hex, 16));
      else if (m[4]) value += codePoint(parseInt(m[4], 8));
      else if (m[5]) value += codePoint(m[5].charCodeAt(0) % 32); // a control character is its letter's code modulo 32 (ASCII)
      else value += C_ESCAPES[m[6]!] ?? `\\${m[6]}`;
    }
  }

  // `...`: the old form of $(...). Inside it a backslash keeps only ` \ and $ (bash manual, "Command Substitution").
  private backtick(nested: Command[]): string {
    const { src } = this;
    const from = this.i++;
    let inner = "";
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNCLOSED);
      if (c === "`") break;
      const n = src[this.i + 1];
      if (c === "\\" && n !== undefined && "`\\$".includes(n)) {
        inner += n;
        this.i += 2;
      } else {
        inner += c;
        this.i++;
      }
    }
    this.i++;
    // A here-document begun on this line must not take its body from a new line inside the backticks.
    if (inner.includes("\n") && this.pending.length + this.waiting > 0) throw new Unreadable(HEREDOC);
    const part = read(inner, "bash");
    nested.push(...part.commands);
    this.hungry = most(this.hungry, part.hungry);
    this.subs.ticks += 2;
    this.merge(part); // its text runs in this line's shell
    this.dynamic = true;
    return src.slice(from, this.i);
  }

  // PowerShell's quotes: any of its quote marks of the kind closes the string, and two together stand for one. Double
  // quotes (`nested` given) also read backtick escapes, variables, $(...) and ${...}.
  private psQuoted(marks: Set<string>, nested?: Command[]): string {
    const { src } = this;
    this.i++;
    let value = "";
    for (;;) {
      const c = src[this.i];
      const n = src[this.i + 1];
      if (c === undefined) throw new Unreadable(UNCLOSED);
      if (marks.has(c)) {
        if (n === undefined || !marks.has(n)) {
          this.i++;
          return value;
        }
        value += c;
        this.i += 2;
      } else if (nested && c === "`") value += this.psEscape();
      else if (nested && c === "$" && n === "(") {
        const from = this.i;
        this.i += 2;
        this.inner(")", nested);
        this.dynamic = true;
        value += src.slice(from, this.i);
      } else if (nested && c === "$" && n === "{") value += this.psBraced();
      else {
        if (nested && c === "$" && /[\w:?^$]/.test(n ?? "")) this.dynamic = true;
        value += c;
        this.i++;
      }
    }
  }

  // A backtick escape in double quotes. `u{...} takes up to six hex digits (about_Special_Characters).
  private psEscape(): string {
    const { src } = this;
    const n = src[this.i + 1];
    const unicode = /u\{([\da-fA-F]{1,6})\}/y;
    unicode.lastIndex = this.i + 1;
    const m = unicode.exec(src);
    if (m) {
      this.i = unicode.lastIndex;
      return codePoint(parseInt(m[1]!, 16));
    }
    this.i += n === undefined ? 1 : 2;
    return n === undefined ? "`" : (PS_ESCAPES[n] ?? n);
  }

  // PowerShell's here-string, read as text (choice 35): its lines up to one that starts with the quote mark and @. Only
  // @"..."@ is expanded, so only its $(...) commands are added (about_Quoting_Rules, "Here-strings").
  private psHere(quote: string, nested: Command[]): string {
    const { src } = this;
    const marks = PS_SINGLE.has(quote) ? PS_SINGLE : PS_DOUBLE;
    const from = this.i;
    for (let line = from; ; ) {
      if (marks.has(src[line] ?? "") && src[line + 1] === "@") {
        const body = src.slice(from, Math.max(from, line - 1));
        this.i = line + 2;
        if (marks === PS_DOUBLE) {
          const reader = new Reader(body, "powershell");
          nested.push(...reader.expansions());
          reader.dotnet();
          this.hungry = most(this.hungry, reader.hungry);
          this.dynamic ||= reader.src.includes("$");
        }
        return body;
      }
      const newline = src.indexOf("\n", line);
      if (newline < 0) throw new Unreadable(HEREDOC); // its end line never came
      line = newline + 1;
    }
  }

  // ${name}: a variable whose name is in braces.
  private psBraced(): string {
    const from = this.i;
    const close = this.src.indexOf("}", from + 2);
    if (close < 0) throw new Unreadable(UNPAIRED);
    this.i = close + 1;
    this.dynamic = true;
    return this.src.slice(from, this.i);
  }
}

// How many leading NAME=value words there are: they only set variables for the command after them (choice 33). Read from
// the word as written, so a quoted "FOO=1" is a command's name.
function assignments(words: Word[], src: string): number {
  let k = 0;
  while (k < words.length && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(src.slice(words[k]!.start, words[k]!.end))) k++;
  return k;
}

// PowerShell's `$x = <command>` and `$x, $y = <command>` run the command: the variables and the = are left out, as bash's
// NAME=value is.
const PS_OPERATOR = /^([-+*/%]|\?\?)?=$/;
const psTargets = (v: string) => /\$|^,$/.test(v) && v.split(",").every((p) => p === "" || /^(\[[^\]]*\])*\$[^=]*$/.test(p));
function psUnassigned(words: Word[], src: string): Word[] {
  for (;;) {
    let k = 0;
    while (k < words.length && !words[k]!.value.includes("=") && psTargets(words[k]!.value)) k++;
    const w = words[k];
    if (!w) return words;
    if (k > 0 && PS_OPERATOR.test(w.value)) {
      words = words.slice(k + 1);
      continue;
    }
    const joined = /^([^=]*?)(?:[-+*/%]|\?\?)?=([\s\S]*)$/.exec(w.value);
    if (!joined || !psTargets(joined[1]!)) return words;
    const rest = joined[2]!;
    // Where the value starts as written, after the = in the word, and whether it is exactly one string (Reader.emit).
    const start = w.start + (/^[^=]*=/.exec(src.slice(w.start, w.end))?.[0].length ?? 0);
    const raw = src.slice(start, w.end);
    const kind = PS_SINGLE.has(raw[0] ?? "") ? PS_SINGLE : PS_DOUBLE.has(raw[0] ?? "") ? PS_DOUBLE : undefined;
    const single = !!kind && raw.length > 1 && kind.has(raw.at(-1)!) && ![...raw.slice(1, -1)].some((ch) => kind.has(ch));
    words = rest ? [{ ...w, value: rest, start, single }, ...words.slice(k + 1)] : words.slice(k + 1);
  }
}

// cmd: a leading @ only stops the command being echoed. Its if and for hold a command in the middle of their words.
function cmdOwn(words: Word[]): Word[] {
  const [first, ...rest] = words;
  if (!first) return words;
  const value = first.value.replace(/^@+/, "");
  const own = value ? [{ ...first, value }, ...rest] : rest;
  if (own[0] && /^(if|for)$/i.test(own[0].value)) throw new Unreadable(CMD_IF);
  return own;
}

// A command's name without its folder, or .exe, .cmd, .bat or .ps1 (npm.cmd, npx.ps1), in lower case, as Windows finds it.
export function nameOf(word: string): string {
  return word.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

// Programs whose words the check reads, which Windows PowerShell 5.1 passes on changed (choice 37): inner double quotes are
// dropped, a word with a blank that ends in a backslash takes in the next word, and an empty word is left out.
const PARSED = new Set([
  "busybox", "cmd", "powershell", "pwsh", "wsl", "sudo", "doas", "find", "forfiles", "uv", "uvx", "pipenv", "poetry", "npx", "bunx", "conda",
]);
const parses = (name: string) => PARSED.has(name) || SH.has(name) || OTHER_SHELLS.has(name) || name in WRAPPERS;
const changed = (w: Word) => w.value.includes('"') || w.value === "" || (/\s/.test(w.value) && w.value.endsWith("\\"));

// Start-up settings a program reads from its environment, which can name a file of code it runs first (choice 37): bash's
// BASH_ENV and the ENV of sh and the others (bash manual, "Bash Startup Files"), node's NODE_OPTIONS (--require, --import),
// ruby's RUBYOPT (-r) and perl's PERL5OPT (-M).
const STARTUP: Record<string, (name: string) => boolean> = {
  BASH_ENV: (name) => SH.has(name),
  ENV: (name) => SH.has(name),
  NODE_OPTIONS: (name) => name === "node" || name === "nodejs",
  RUBYOPT: (name) => name === "ruby",
  PERL5OPT: (name) => name === "perl",
};

// A command, then what it runs: the text it gives a shell (choice 2), or the command in the rest of its words (choice 34).
function expand(words: Word[], text: string, src: string, g: Grammar, ctx: Context): Part {
  const [first, ...args] = words as [Word, ...Word[]];
  const { placeholder, cwd } = ctx;
  const name = nameOf(first.value);
  const shown = first.value.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
  // A name known only when the line runs: a variable, a command's output, a glob, a brace expansion, or a placeholder.
  // PowerShell's own are checked after & and . (Reader.command); a first word there is an expression, not a name.
  const glob = g === "bash" && /\{[^{}]*(,|\.\.)[^{}]*\}|[*?]|\[[^\]]*\]/.test(first.shape);
  if (((g === "bash" || ctx.inner) && first.dynamic) || glob || (placeholder && first.value.includes(placeholder))) throw new Unreadable(NAMED);
  if (g === "bash" && name === "eval") throw new Unreadable(EVAL);
  if (g === "powershell" && (name === "iex" || name === "invoke-expression")) throw new Unreadable(IEX);
  if (g === "powershell" && PS_FOLLOW.has(name)) throw new Unreadable(FOLLOW);
  if (g === "powershell" && parses(name) && args.some(changed)) throw requoted(shown);
  if (ctx.inner && MOVES.has(name)) ctx.lost?.();
  const commands: Command[] = [{ words: words.map((w) => w.value), text }];
  // The arithmetic names and command substitutions in the shell texts it gives, for the line's check (Reader.checkArithmetic).
  const arith: string[] = [];
  const subs: Subs = { dollars: 0, ticks: 0 };
  const gather = (part: Part) => {
    arith.push(...(part.arith ?? []));
    addSubs(subs, part);
  };
  // A bash function or alias made earlier on the line runs here, with this command's input (choice 37).
  let hungry = g === "bash" ? (ctx.functions.get(first.value) ?? NONE) : NONE;
  const run = (runs: Runs) => {
    if (runs.dynamic || (placeholder && runs.texts.some((t) => t.includes(placeholder)))) throw new Unreadable(MADE);
    for (const t of runs.texts) {
      // An empty text is filled in by xargs or by a word PowerShell dropped: the shell reads its input.
      if (t.trim() === "") hungry = SHELL;
      const part = read(t, runs.grammar, { env: ctx.vars, cwd, positional: true });
      if (runs.again) for (const c of part.commands) REREAD.add(c);
      commands.push(...part.commands);
      hungry = most(hungry, part.hungry); // the shell's own commands read its input
      gather(part);
    }
  };
  const code = interpreterRun(name, args, cwd);
  // A shell or an interpreter given a process substitution as any of its words, an option's value included, as in
  // `bash --rcfile <(curl x)` or `sh -c '. "$1"' _ <(curl x)`, may read it as code (choice 37).
  const shell = SH.has(name) || OTHER_SHELLS.has(name) || ["cmd", "powershell", "pwsh", "wsl"].includes(name);
  let program = !!code || shell || (g === "bash" && (name === "source" || name === "."));
  if (program && args.some((a) => a.fed)) throw new Unreadable(PIPED);
  if (code) {
    // For an interpreter, only the words up to the one that settles what it runs matter.
    if (g === "powershell" && args.slice(0, code.decides).some(changed)) throw requoted(shown);
    if (code.code && placeholder && code.code.value.includes(placeholder)) throw new Unreadable(MADE);
    if (code.reads) hungry = most(hungry, CODE);
  } else {
    const runs = shellRuns(name, args, g, cwd);
    if (runs === undefined) hungry = SHELL;
    else if (runs) run(runs);
  }
  const startup = ctx.vars.some((v) => {
    const eq = v.value.indexOf("=");
    const matches = STARTUP[v.value.slice(0, eq)];
    return matches?.(name) && (v.dynamic || holdsInput(v.value.slice(eq + 1), cwd));
  });
  if (startup) hungry = most(hungry, SH.has(name) ? SHELL : CODE);
  for (const w of wrapped(name, args, g, src)) {
    if ("texts" in w) {
      run(w);
      continue;
    }
    if ("reads" in w) {
      hungry = most(hungry, w.reads);
      continue;
    }
    const inner: Context = { ...ctx, inner: true, placeholder: w.placeholder ?? placeholder, vars: [...ctx.vars, ...(w.vars ?? [])] };
    const part = expand(w.words, src.slice(w.words[0]!.start, w.words.at(-1)!.end), src, w.grammar ?? g, inner);
    // xargs gives the command its input, so a shell or an interpreter there runs it.
    if (name === "xargs" && part.hungry) throw new Unreadable(PIPED);
    commands.push(...part.commands);
    hungry = most(hungry, part.hungry);
    program ||= !!part.program;
    gather(part);
  }
  return { commands, hungry, program, arith, subs };
}

// The text a command gives a shell to run; null when it gives none; undefined when the shell reads its input, as in
// `curl x | sh`, and runs what comes down the pipe. Empty text counts as reading its input, as xargs or a dropped word
// may fill it in.
function shellRuns(name: string, args: Word[], g: Grammar, cwd: Cwd): Runs | null | undefined {
  if (name === "wsl") {
    const run = wslRun(args);
    if ("text" in run && run.text.length > 0) return { grammar: "bash", texts: [linuxLine(run.text)], dynamic: run.text.some((w) => w.dynamic) };
    return "none" in run || "exec" in run ? null : undefined;
  }
  if (name === "sudo" || name === "doas") {
    const { rest, used } = sudoRun(name, args, g);
    return rest.length === 0 && (used.has("s") || used.has("i") || used.has("shell") || used.has("login")) ? undefined : null;
  }
  if (SH.has(name)) return shText(args, cwd);
  if (name === "cmd") return cmdText(args);
  if (name === "powershell" || name === "pwsh") return psText(name, args);
  if (OTHER_SHELLS.has(name)) return otherShell(name, args, cwd);
  if (g === "bash" && name === "trap") return trapText(args);
  if (g === "bash" && (name === "source" || name === ".") && args[0] && takesInput(args[0], cwd)) return undefined;
  return null;
}

// What bash, sh, zsh, dash, ksh or mksh runs: the text after -c, null for a script file, undefined when it reads its input:
// with no script, with -s, or with its own input as the script. Without its text, -c runs what xargs gives it.
function shText(args: Word[], cwd: Cwd): Runs | null | undefined {
  let c = false;
  let s = false;
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!.value;
    if (a === "-" || a === "--") {
      k++;
      break;
    }
    if (a.startsWith("--")) {
      if (a === "--rcfile" || a === "--init-file") k++;
      continue;
    }
    if (!/^[-+]./.test(a)) break;
    c ||= a.includes("c");
    s ||= a.includes("s");
    if (/[oO]/.test(a)) k++; // -o and -O name an option in the next word
  }
  const text = args[k];
  if (c) return text && text.value.trim() !== "" ? { grammar: "bash", texts: [text.value], dynamic: text.dynamic } : undefined;
  return s || !text || takesInput(text, cwd) ? undefined : null;
}

// Shells whose grammar the check does not read: fish, csh, tcsh, nu, xonsh and elvish (choice 37). Text given to them
// (-c; fish's -C, --command and --init-command; nu's -e and --execute) is unreadable; with no script, with tcsh's -s or with
// nu's --stdin they read their input. Their options on their own are listed (each one's --help); any other is taken to
// have a value in the next word, so that a script it hides makes the line read as reading the input.
const OTHER_SHELLS = new Set(["fish", "csh", "tcsh", "nu", "xonsh", "elvish"]);
const OTHER_FLAGS = new Set([
  "-i", "-l", "-n", "-N", "-p", "-P", "-v", "-V", "-x", "-X", "-f", "-b", "-q", "-t", "-h", "-m", "-F", "-D", "-st",
  "--login", "--interactive", "--private", "--no-config", "--no-execute", "--version", "--help", "--no-rc", "--no-config-file",
  "--no-std-lib", "--no-script-cache", "--cache-everything", "--timings", "-norc", "-help", "-version", "-buildinfo", "-json",
  "-compileonly", "-noisy",
]);
function otherShell(name: string, args: Word[], cwd: Cwd): null | undefined {
  for (let k = 0; k < args.length; k++) {
    const word = args[k]!;
    const { value } = word;
    if (OTHER_FLAGS.has(value)) continue;
    if (/^--(init-)?command|^--execute|^--commands/.test(value) || /^-[a-zA-Z]*[cC][a-zA-Z]*$/.test(value) || (name === "nu" && value === "-e")) {
      throw new Unreadable(OTHER);
    }
    if (value === "--stdin" || (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(value) && (name === "csh" || name === "tcsh"))) return undefined;
    if (value === "-") return undefined;
    if (value === "--") {
      const script = args[k + 1];
      return !script || takesInput(script, cwd) ? undefined : null;
    }
    if (!value.startsWith("-")) return takesInput(word, cwd) ? undefined : null;
    if (!value.includes("=")) k++;
  }
  return undefined;
}

// bash's trap: `trap TEXT SIGNAL...` runs TEXT when the signal comes; `trap - SIGNAL` and `trap SIGNAL` set none.
function trapText(args: Word[]): Runs | null {
  let k = 0;
  while (k < args.length && /^-[lp]+$/.test(args[k]!.value)) k++;
  if (args[k]?.value === "--") k++;
  const text = args[k];
  if (!text || args.length - k < 2 || text.value === "-") return null;
  return { grammar: "bash", texts: [text.value], dynamic: text.dynamic };
}

// PowerShell's own parameters (`powershell -?`, `pwsh -?`): the full name, the shortest prefix it accepts, what it does,
// and its other names.
type PsKind = "command" | "commandwithargs" | "encoded" | "file" | "value" | "flag";
const PS_PARAMS: [string, string, PsKind, ...string[]][] = [
  ["command", "c", "command"],
  ["commandwithargs", "commandwithargs", "commandwithargs", "cwa"],
  ["encodedcommand", "e", "encoded", "ec"],
  ["encodedarguments", "encodeda", "encoded", "ea"],
  ["executionpolicy", "ex", "value", "ep"],
  ["file", "f", "file"],
  ["inputformat", "in", "value", "if"],
  ["interactive", "i", "flag"],
  ["outputformat", "o", "value", "of"],
  ["windowstyle", "w", "value"],
  ["workingdirectory", "wo", "value", "wd"],
  ["version", "v", "value"],
  ["configurationname", "config", "value"],
  ["configurationfile", "configurationf", "value"],
  ["settingsfile", "settings", "value"],
  ["custompipename", "custompipename", "value"],
  ["psconsolefile", "psconsolefile", "value"],
  ["noprofile", "nop", "flag"],
  ["noprofileloadtime", "noprofileloadtime", "flag"],
  ["nologo", "nol", "flag"],
  ["noexit", "noe", "flag"],
  ["noninteractive", "noni", "flag"],
  ["sta", "s", "flag"],
  ["mta", "mta", "flag"],
  ["login", "l", "flag"],
  ["help", "h", "flag", "?"],
];

// What powershell or pwsh runs: the words after -Command, joined as PowerShell joins them, or from a first word that is not
// a parameter; null for -File; undefined when it reads its input (-Command -, -File -, or nothing to run).
function psText(name: string, args: Word[]): Runs | null | undefined {
  const rest = (from: number): Runs | undefined => {
    const words = args.slice(from);
    const text = words.map((w) => w.value).join(" ");
    // A script block alone, not in quotes, was read already as one of the line's words.
    const again = words.length === 1 && !words[0]!.single && /^\{[\s\S]*\}$/.test(text.trim());
    return text.trim() === "" || text === "-" ? undefined : { grammar: "powershell", texts: [text], dynamic: words.some((w) => w.dynamic), again };
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.value;
    const key = /^(?:--?|\/)(.+)$/.exec(a)?.[1]?.toLowerCase();
    const param = key && PS_PARAMS.find(([full, shortest, , ...names]) => names.includes(key) || (full.startsWith(key) && key.length >= shortest.length));
    if (!param) {
      if (key && !a.startsWith("/")) throw unknownOption(name, a);
      return rest(k);
    }
    const kind = param[2];
    if (kind === "encoded") throw new Unreadable(ENCODED);
    if (kind === "file") return args[k + 1]?.value === "-" ? undefined : null;
    if (kind === "command") return rest(k + 1);
    // -CommandWithArgs runs only its next word; the words after it are that text's arguments.
    if (kind === "commandwithargs") return rest(k + 1) && { grammar: "powershell", texts: [args[k + 1]!.value], dynamic: args[k + 1]!.dynamic };
    if (kind === "value") k++;
  }
  return undefined;
}

// What cmd runs (`cmd /?`, and tried on Windows 11): the text after the first /c, /k or /r anywhere in its words, even joined
// to another switch (/q/c) or to the text (/cdel); undefined when there is none and it reads its input. Text that starts with
// a quote loses that quote and the last one, unless there is no /s, exactly two quotes with blanks and none of & < > ( ) @ ^ |
// between them, and what they hold names a program. As the check cannot tell that last, such text is read both ways.
// %NAME% is filled in before cmd reads the text, so text holding one is made only when it runs; so is text holding !NAME!
// when /v or /v:on turns on delayed expansion.
function cmdText(args: Word[]): Runs | undefined {
  const line = args.map((w) => w.value).join(" ");
  const m = /\/[ckr]/i.exec(line);
  if (!m) return undefined;
  const text = line.slice(m.index + 2).replace(/^[ \t]+/, "");
  if (text.trim() === "") return undefined; // nothing after /c: xargs or a dropped word fills it in
  const delayed = /\/v(:on)?(\s|\/|$)/i.test(line.slice(0, m.index));
  const dynamic = args.some((w) => w.dynamic) || /%[^%\s]+%/.test(text) || (delayed && /![^!\s]+!/.test(text));
  if (!text.startsWith('"')) return { grammar: "cmd", texts: [text], dynamic };
  const last = text.lastIndexOf('"');
  const stripped = text.slice(1, last) + text.slice(last + 1);
  const between = text.slice(1, text.indexOf('"', 1));
  const kept = !/\/s/i.test(line.slice(0, m.index)) && text.split('"').length === 3 && !/[&<>()@^|]/.test(between) && /\s/.test(between);
  return { grammar: "cmd", texts: kept ? [text, stripped] : [stripped], dynamic };
}

// A command's own options: those on their own, and those that take a value.
interface Options {
  flags: string; // short options on their own
  values: string; // short options whose value is attached or the next word
  attached?: string; // short options whose value can only be attached
  long?: string[]; // long options on their own, or with =value
  longValues?: string[]; // long options whose value is after = or the next word
}
// From each command's --help: GNU coreutils 8.32 (env, nohup, nice, timeout, stdbuf; 9.5 adds env's -a), findutils 4.9
// (xargs, whose --max-lines, --eof and --replace take a value only after =), GNU time 1.9, procps-ng 4.0 (watch), busybox's
// usage, and bash's help for exec, command and builtin.
const WRAPPERS: Record<string, Options> = {
  env: {
    flags: "i0v",
    values: "uCa",
    long: ["ignore-environment", "null", "debug", "block-signal", "default-signal", "ignore-signal", "list-signal-handling"],
    longValues: ["unset", "chdir", "argv0"],
  },
  nohup: { flags: "", values: "" },
  time: { flags: "pvqaV", values: "of", long: ["portability", "verbose", "quiet", "append"], longValues: ["output", "format"] },
  nice: { flags: "0123456789", values: "n", longValues: ["adjustment"] }, // -10 is the old way to write -n 10
  timeout: { flags: "v", values: "sk", long: ["preserve-status", "foreground", "verbose"], longValues: ["signal", "kill-after"] },
  stdbuf: { flags: "", values: "ioe", longValues: ["input", "output", "error"] },
  exec: { flags: "cl", values: "a" },
  command: { flags: "pvV", values: "" },
  builtin: { flags: "", values: "" },
  busybox: { flags: "", values: "", long: ["list", "list-full"] }, // `busybox sh` and `busybox rm` run its own sh and rm
  xargs: {
    flags: "0rtpxo",
    values: "adEILnPs",
    attached: "eil",
    long: ["null", "no-run-if-empty", "verbose", "interactive", "exit", "open-tty", "show-limits", "eof", "replace", "max-lines"],
    longValues: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"],
  },
  watch: {
    flags: "bcCdegprtwxhv",
    values: "nqs",
    long: ["beep", "color", "no-color", "differences", "errexit", "chgexit", "precise", "no-rerun", "no-title", "no-wrap", "exec"],
    longValues: ["interval", "equexit", "shotsdir"],
  },
  // Choice 49, from each one's --help or man page: util-linux 2.39 (setsid, ionice, chrt, taskset, flock, unshare, script),
  // coreutils 9 (chroot), strace 6, systemd 255 (systemd-run), shadow (sg), macOS (caffeinate) and GNU parallel. Only options
  // whose value is certain are listed; any other makes the line unreadable.
  setsid: { flags: "cfwhV", values: "", long: ["ctty", "fork", "wait"] },
  ionice: { flags: "thV", values: "cnpPu", long: ["ignore"], longValues: ["class", "classdata", "pid", "pgid", "uid"] },
  chrt: {
    flags: "abdfimoprRvhV",
    values: "DPT",
    long: ["all-tasks", "batch", "deadline", "fifo", "idle", "max", "other", "pid", "rr", "reset-on-fork", "verbose"],
    longValues: ["sched-deadline", "sched-period", "sched-runtime"],
  },
  taskset: { flags: "acphV", values: "", long: ["all-tasks", "cpu-list", "pid"] },
  flock: {
    flags: "sxenouFhV",
    values: "wE",
    long: ["shared", "exclusive", "nonblock", "nb", "unlock", "close", "no-fork", "verbose"],
    longValues: ["timeout", "wait", "conflict-exit-code"],
  },
  unshare: {
    flags: "fimnpuUCTrchV",
    values: "RwSG",
    long: [
      "fork", "ipc", "mount", "net", "pid", "uts", "user", "cgroup", "time", "kill-child", "mount-proc", "map-root-user",
      "map-current-user", "map-auto", "keep-caps",
    ],
    longValues: ["map-user", "map-group", "map-users", "map-groups", "propagation", "setgroups", "root", "wd", "setuid", "setgid", "monotonic", "boottime"],
  },
  chroot: { flags: "", values: "", long: ["skip-chdir"], longValues: ["groups", "userspec"] },
  strace: {
    flags: "AcCdDfFhiknqrtTvVwxyYzZ",
    values: "abeEIoOpPsSuUX",
    long: [
      "summary-only", "summary", "summary-wall-clock", "debug", "daemonize", "follow-forks", "output-separately", "instruction-pointer",
      "stack-trace", "syscall-number", "output-append-mode", "quiet", "relative-timestamps", "absolute-timestamps", "timestamps",
      "syscall-times", "no-abbrev", "strings-in-hex", "decode-fds", "decode-pids", "successful-only", "failed-only", "seccomp-bpf",
      "kill-on-exit", "pidns-translation", "tips",
    ],
    longValues: [
      "attach", "trace", "trace-path", "signal", "status", "abbrev", "verbose", "raw", "read", "write", "fault", "inject", "detach-on",
      "env", "user", "argv0", "interruptible", "columns", "output", "string-limit", "const-print-style", "summary-syscall-overhead",
      "summary-sort-by", "summary-columns",
    ],
  },
  "systemd-run": {
    flags: "rdtPqGSh",
    values: "upEHM",
    long: [
      "no-ask-password", "scope", "slice-inherit", "remain-after-exit", "send-sighup", "same-dir", "pty", "pipe", "shell", "quiet",
      "wait", "collect", "user", "system", "on-clock-change", "on-timezone-change", "no-block",
    ],
    longValues: [
      "unit", "property", "description", "slice", "service-type", "uid", "gid", "nice", "working-directory", "setenv", "host", "machine",
      "on-active", "on-boot", "on-startup", "on-unit-active", "on-unit-inactive", "on-calendar", "path-property", "socket-property",
      "timer-property",
    ],
  },
  sg: { flags: "", values: "" }, // read by sgRun
  caffeinate: { flags: "disum", values: "tw" },
  // util-linux's and BSD's script; -t is a timing file attached in one and the next word in the other, so it is not read.
  script: {
    flags: "aefqhVFkdpr",
    values: "cEBIOTmo",
    long: ["append", "return", "flush", "force", "quiet", "timing"],
    longValues: ["command", "echo", "log-io", "log-in", "log-out", "log-timing", "logging-format", "output-limit"],
  },
  // Not --plus, whose replacement strings ({%x}, {/x/}) change the argument, nor -C or --colsep, which split it.
  parallel: {
    flags: "0kmqrtuvX",
    values: "adEIjLnNPsS",
    long: [
      "null", "keep-order", "quote", "no-run-if-empty", "verbose", "ungroup", "xargs", "line-buffer", "lb", "group", "bar", "progress",
      "eta", "tag", "dry-run", "will-cite", "no-notice", "shuf", "pipe", "pipepart",
    ],
    longValues: [
      "arg-file", "delimiter", "jobs", "max-procs", "max-args", "max-lines", "max-chars", "sshlogin", "halt", "joblog", "results",
      "tagstring", "timeout", "retries", "nice", "block", "env", "header",
    ],
  },
};
// ionice, chrt and taskset given a running process (-p, and ionice's -P and -u), and chrt -m, which shows its limits, start
// no command.
const STARTS_NONE: Record<string, string[]> = { ionice: ["p", "P", "u", "pid", "pgid", "uid"], chrt: ["p", "pid", "m", "max"], taskset: ["p", "pid"] };
// cmd's start (`start /?`): switches on their own, and those that take the next word.
const START_FLAGS = ["/i", "/min", "/max", "/separate", "/shared", "/low", "/normal", "/high", "/realtime", "/abovenormal", "/belownormal", "/wait", "/b"];
const START_VALUES = ["/d", "/node", "/affinity", "/machine"];

// sudo's options (sudo(8), 1.9), with Windows 11's (microsoft/sudo: --inline, --new-window, --disable-input; its -N, -E and
// -D are sudo's own letters), and doas's (doas(1), OpenBSD 7.5). sudo's -h is both help and -h HOST, so it is not read.
const SUDO: Options = {
  flags: "ABbEeHiKklNnPSsVv",
  values: "CDgpRrtTUu",
  long: [
    "askpass", "bell", "background", "preserve-env", "edit", "set-home", "login", "remove-timestamp", "reset-timestamp", "list",
    "no-update", "non-interactive", "preserve-groups", "stdin", "shell", "validate", "inline", "new-window", "disable-input",
  ],
  longValues: ["close-from", "chdir", "group", "prompt", "chroot", "role", "type", "command-timeout", "other-user", "user"],
};
const DOAS: Options = { flags: "Lns", values: "aCu" };

// sudo's or doas's command, after its options and sudo's NAME=value words, the options it was given, and those words.
// Windows 11's sudo, met in PowerShell's or cmd's grammar, also has `run`, which takes the same options before its
// command, and `config`, which runs nothing (microsoft/sudo); Linux's sudo would run a program named run or config.
function sudoRun(name: string, args: Word[], g: Grammar): { rest: Word[]; used: Set<string>; vars: Word[] } {
  const used = new Set<string>();
  const windows = name === "sudo" && g !== "bash";
  let from = skip(name, args, name === "sudo" ? SUDO : DOAS, used);
  if (windows && args[from]?.value === "run") from = skip(name, args, SUDO, used, from + 1);
  let k = from;
  if (name === "sudo") while (k < args.length && /^[A-Za-z_]\w*=/.test(args[k]!.value)) k++;
  // sudo -e edits files, -l lists what may run, -v, -K and -V run nothing; doas -C checks its settings and -L logs out.
  const none = name === "sudo" ? ["e", "edit", "l", "list", "v", "validate", "K", "remove-timestamp", "V"] : ["C", "L"];
  const config = windows && args[from]?.value === "config";
  return { rest: config || none.some((o) => used.has(o)) ? [] : args.slice(k), used, vars: args.slice(from, k) };
}

// wsl's own options (`wsl --help`, Windows 11): those for running a command, and those that manage WSL and run none.
export const WSL_VALUES = ["--cd", "--distribution", "-d", "--distribution-id", "--user", "-u", "--shell-type"];
const WSL_MANAGE = [
  "--help", "--debug-shell", "--install", "--manage", "--mount", "--set-default-version", "--shutdown", "--status", "--unmount",
  "--uninstall", "--update", "--version", "-v", "--export", "--import", "--import-in-place", "--list", "-l", "--set-default", "-s",
  "--set-version", "--terminate", "-t", "--unregister",
];

// What wsl runs: a command line for Linux's shell, the words of a command run without a shell (-e, --exec), nothing (its
// management options), or Linux's shell reading its input when no command is given. A first word ~ only starts it in the
// Linux home folder, and options may follow it.
function wslRun(args: Word[]): { text: Word[] } | { exec: Word[] } | { none: true } | { input: true } {
  for (let k = args[0]?.value === "~" ? 1 : 0; k < args.length; k++) {
    const a = args[k]!.value;
    if (a === "-e" || a === "--exec") return { exec: args.slice(k + 1) };
    if (a === "--") return { text: args.slice(k + 1) };
    if (WSL_VALUES.includes(a)) k++;
    else if (WSL_MANAGE.includes(a)) return { none: true };
    else if (a !== "--system") {
      if (a.startsWith("-")) throw unknownOption("wsl", a);
      return { text: args.slice(k) };
    }
  }
  return { input: true };
}

// The command line Windows passes on, as Linux's shell reads it. A word holding a blank or a double quote, or empty, is put in
// double quotes with its inner quotes escaped, as a C program's arguments are written (Microsoft's "Parsing C command-line
// arguments": a quote becomes \", and the backslashes before it, or before the closing quote, are doubled).
function linuxLine(words: Word[]): string {
  const quoted = (value: string) => {
    let out = '"';
    let slashes = "";
    for (const ch of value) {
      if (ch === "\\") slashes += ch;
      else {
        out += ch === '"' ? `${slashes}${slashes}\\"` : `${slashes}${ch}`;
        slashes = "";
      }
    }
    return `${out}${slashes}${slashes}"`;
  };
  return words.map((w) => (w.value === "" || /[\s"]/.test(w.value) ? quoted(w.value) : w.value)).join(" ");
}

// Interpreters that run code from their input when given no script, or - or their own input as the script (choice 37). From
// each one's --help: Python 3.12 (and PyPy and IPython, read as Python), Node.js 24, perl 5.38 (perlrun), ruby 3.3 and irb,
// PHP 8.3, Lua 5.4, R 4.4's Rscript, Tcl 8.6's tclsh, osascript (macOS), Deno 2 (`deno run --help`) and Bun 1.1. `code`
// options give the code themselves (`files` give a script file, as php -f); `interactive` ones read code from the input
// after the script; `words` are options written with one dash that take a value, as tclsh's -encoding. An option not
// listed is taken to have a value in the next word, so that a script it hides makes the line read as code from the input;
// a value that is - or names the input counts as reading the input too.
interface Interpreter {
  flags: string;
  values: string;
  attached?: string; // short options whose value can only be attached
  code: string;
  files?: string;
  interactive: string;
  long: string[];
  longValues: string[];
  longCode?: string[];
  words?: string[];
}
const INTERPRETERS: Record<string, Interpreter> = {
  python: {
    flags: "bBdEhIOPqsSuvVx?",
    values: "WX",
    code: "cm",
    interactive: "i",
    long: ["help", "version", "help-env", "help-xoptions", "help-all"],
    longValues: ["check-hash-based-pycs"],
  },
  node: {
    flags: "hvc",
    values: "rC",
    code: "ep",
    interactive: "i",
    long: [
      "help", "version", "check", "trace-warnings", "enable-source-maps", "inspect", "inspect-brk", "test", "watch",
      "expose-gc", "preserve-symlinks", "pending-deprecation", "trace-deprecation", "throw-deprecation", "abort-on-uncaught-exception",
      "frozen-intrinsics", "experimental-strip-types", "experimental-transform-types", "experimental-vm-modules",
    ],
    longValues: ["require", "import", "input-type", "loader", "experimental-loader", "title", "env-file", "conditions", "inspect-port", "redirect-warnings"],
    longCode: ["eval", "print", "run"],
  },
  nodejs: { flags: "hvc", values: "rC", code: "ep", interactive: "i", long: ["help", "version"], longValues: [], longCode: ["eval", "print"] },
  perl: { flags: "acnpstTuUwWXSvh", values: "I", attached: "0CdDilmMxF", code: "eE", interactive: "", long: [], longValues: [] },
  ruby: {
    flags: "acdlnpsSvwyhU",
    values: "CEIr",
    attached: "WxTK0Fi",
    code: "e",
    interactive: "",
    long: ["help", "version", "verbose", "copyright", "yjit"],
    longValues: [],
  },
  irb: { flags: "fdUwv", values: "rIE", attached: "W", code: "", interactive: "", long: ["noinspect", "inspect", "noprompt", "simple-prompt"], longValues: [] },
  php: { flags: "hilmnsvwHq", values: "cdztS", code: "rBRE", files: "fF", interactive: "a", long: [], longValues: [] },
  lua: { flags: "vEW", values: "l", code: "e", interactive: "i", long: [], longValues: [] },
  rscript: {
    flags: "",
    values: "",
    code: "e",
    interactive: "",
    long: ["verbose", "vanilla", "restore", "save", "version", "help", "slave", "quiet", "silent"],
    longValues: [],
  },
  tclsh: { flags: "", values: "", code: "", interactive: "", long: [], longValues: [], words: ["-encoding"] },
  osascript: { flags: "", values: "ls", code: "e", interactive: "i", long: [], longValues: [] },
};
const DENO: Interpreter = {
  flags: "Aqr",
  values: "cL",
  code: "",
  interactive: "",
  long: ["allow-all", "reload", "watch", "check", "quiet", "cached-only", "frozen", "inspect", "inspect-brk", "inspect-wait", "hmr", "node-modules-dir"],
  longValues: ["config", "import-map", "lock", "cert", "location", "seed", "env-file", "ext", "log-level"],
};
const BUN: Interpreter = {
  flags: "bh",
  values: "rc",
  code: "ep",
  interactive: "",
  long: ["watch", "hot", "smol", "bun", "silent", "inspect", "inspect-brk", "inspect-wait", "help", "version"],
  longValues: ["preload", "config", "cwd", "env-file", "port"],
  longCode: ["eval", "print"],
};
// deno's and bun's commands that run no script of their own (`deno --help`, `bun --help`).
const DENO_TOOLS = new Set([
  "add", "bench", "bundle", "cache", "check", "clean", "compile", "completions", "coverage", "doc", "fmt", "info", "init", "install",
  "jupyter", "lint", "lsp", "outdated", "publish", "remove", "task", "test", "types", "uninstall", "upgrade", "x",
]);
const BUN_TOOLS = new Set([
  "test", "x", "install", "i", "add", "a", "remove", "rm", "update", "outdated", "link", "unlink", "pm", "build", "init", "create", "c",
  "upgrade", "publish", "patch", "audit", "info", "why",
]);
const AWK = new Set(["awk", "gawk", "mawk", "nawk"]);

// What an interpreter runs: whether it reads its code from its input, how many of its first words settle that, and the code
// given in the line, if any.
interface InterpreterRun {
  reads: boolean;
  decides: number;
  code?: Word;
}

// Whether a word naming a script or an option's value may be the input: missing, made only when the line runs, - , or a
// path to the input (holdsInput).
function namesInput(word: Word | undefined, cwd: Cwd, value = word?.value): boolean {
  if (word?.fed) throw new Unreadable(PIPED); // a process substitution: another command's output as the code
  return !word || word.dynamic || holdsInput(value ?? "", cwd);
}

function interpreterRun(name: string, args: Word[], cwd: Cwd): InterpreterRun | undefined {
  if (AWK.has(name)) return awkRun(args, cwd);
  if (name === "deno") return denoRun(args, cwd);
  if (name === "bun") return bunRun(args, cwd);
  if (name === "jshell") return { reads: true, decides: args.length }; // it reads code from its input after any files it loads
  const key = /^(python|pypy|ipython)[\d.]*$/.test(name) ? "python" : /^lua(jit|[\d.]*)$/.test(name) ? "lua" : /^tclsh[\d.]*$/.test(name) ? "tclsh" : name;
  const it = INTERPRETERS[key];
  return it && interpreted(args, it, 0, cwd);
}

// The script a command's words give an interpreter the reader knows, for the rule on a script from a web address (choice
// 44): the word its options end at, read with the same tables. Undefined when it runs code given in the line or reads its
// input, and for awk, whose first word is its program.
export function scriptOf(words: string[]): string | undefined {
  const [first, ...rest] = words;
  const name = nameOf(first ?? "");
  if (AWK.has(name)) return undefined;
  const args = rest.map((value): Word => ({ value, start: 0, end: 0, dynamic: false, shape: value }));
  try {
    const run = interpreterRun(name, args, KNOWN);
    return run && !run.reads && !run.code ? args[run.decides - 1]?.value : undefined;
  } catch (error) {
    if (error instanceof Unreadable) return undefined; // as python -c with no code: no script
    throw error;
  }
}

// Code given in the line, as with -c, is not read by the check (the plan's known limit). With none, xargs gives it.
function given(code: Word | undefined, at: number): InterpreterRun {
  if (!code) throw new Unreadable(MADE);
  return { reads: false, decides: at, code };
}

// Reads an interpreter's options from word `from`, up to its code or its script.
function interpreted(args: Word[], it: Interpreter, from: number, cwd: Cwd): InterpreterRun {
  let k = from;
  for (; k < args.length; k++) {
    const word = args[k]!;
    const a = word.value;
    if (a === "--") {
      k++;
      break;
    }
    if (a === "-" || !a.startsWith("-")) break;
    if (it.words?.includes(a)) {
      k++;
      if (namesInput(args[k], cwd)) return { reads: true, decides: k + 1 };
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const option = a.slice(2, eq < 0 ? undefined : eq);
      const attached = eq < 0 ? undefined : a.slice(eq + 1);
      if (it.longCode?.includes(option)) return given(attached === undefined ? args[k + 1] : word, k);
      if (option === "interactive") return { reads: true, decides: k + 1 };
      if (attached !== undefined) {
        if (namesInput(word, cwd, attached)) return { reads: true, decides: k + 1 };
        continue;
      }
      // node's and deno's --no-..., --allow-..., --deny-..., --unstable... and --experimental-... are on their own.
      const alone = it.long.includes(option) || /^(no|allow|deny|unstable)-|^unstable$/.test(option);
      if (alone || (option.startsWith("experimental-") && !it.longValues.includes(option))) continue;
      k++; // a value in the next word, for a listed option and, to be safe, for one not listed
      if (namesInput(args[k], cwd)) return { reads: true, decides: k + 1 };
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]!;
      const rest = a.slice(j + 1);
      if (it.files?.includes(letter)) {
        const file = rest ? word : args[k + 1];
        return { reads: namesInput(file, cwd, rest || file?.value), decides: (rest ? k : k + 1) + 1 };
      }
      if (it.code.includes(letter)) return given(rest ? word : args[k + 1], k);
      if (it.interactive.includes(letter)) return { reads: true, decides: k + 1 };
      if (it.flags.includes(letter)) continue;
      if (it.attached?.includes(letter)) {
        if (rest && namesInput(word, cwd, rest)) return { reads: true, decides: k + 1 };
        break;
      }
      // A value, attached or in the next word: a listed option's, and, to be safe, one not listed.
      if (!rest) k++;
      if (namesInput(rest ? word : args[k], cwd, rest || args[k]?.value)) return { reads: true, decides: k + 1 };
      break;
    }
  }
  const script = args[k];
  return { reads: !script || script.value === "-" || namesInput(script, cwd), decides: k + 1 };
}

// deno: `deno run` and `deno serve` run a script, `deno SCRIPT` too; `deno eval` runs code given; deno alone and `deno repl`
// read code from the input.
function denoRun(args: Word[], cwd: Cwd): InterpreterRun {
  const first = args[0]?.value;
  if (first === undefined || first === "repl") return { reads: true, decides: 1 };
  if (first === "run" || first === "serve") return interpreted(args, DENO, 1, cwd);
  if (first === "eval") {
    const k = args.findIndex((w, i) => i > 0 && !w.value.startsWith("-"));
    return given(args[k], k < 0 ? 1 : k);
  }
  if (DENO_TOOLS.has(first)) return { reads: false, decides: 1 };
  return interpreted(args, DENO, 0, cwd);
}

// bun: `bun run` and `bun SCRIPT` run a script; bun alone and `bun repl` are taken to read code from the input; `bun exec`
// runs text in Bun's own shell, whose grammar the check does not read.
function bunRun(args: Word[], cwd: Cwd): InterpreterRun {
  const first = args[0]?.value;
  if (first === undefined || first === "repl") return { reads: true, decides: 1 };
  if (first === "exec") throw new Unreadable(OTHER);
  if (first === "run") return interpreted(args, BUN, 1, cwd);
  if (BUN_TOOLS.has(first)) return { reads: false, decides: 1 };
  return interpreted(args, BUN, 0, cwd);
}

// awk takes its program from its first word, gawk's -e or --source, or a file: -f FILE (gawk's --file, and its -E/--exec
// and -i/--include too), from the input when that file is the input (gawk manual, "Command-Line Options"). Its program can
// run shell commands with system(), so a program xargs gives it is made only when the line runs, as with python -c.
function awkRun(args: Word[], cwd: Cwd): InterpreterRun {
  let k = 0;
  let program = false;
  for (; k < args.length; k++) {
    const word = args[k]!;
    const a = word.value;
    if (a === "--") {
      k++;
      break;
    }
    if (a === "-" || !a.startsWith("-")) break;
    const file = /^(?:-([fEi])(.*)|--(file|exec|include)(?:=(.*))?)$/.exec(a);
    const source = /^(?:-e(.*)|--source(?:=(.*))?)$/.exec(a);
    if (file) {
      const attached = file[2] || file[4];
      const target = attached ? word : args[++k];
      if (namesInput(target, cwd, attached ?? target?.value)) return { reads: true, decides: k + 1 };
      program = true;
    } else if (source) {
      const attached = source[1] || source[2];
      given(attached ? word : args[k + 1], k);
      if (!attached) k++;
      program = true;
    } else if (/^-[Fvl]$|^--(field-separator|assign|load)$/.test(a)) k++;
  }
  return program ? { reads: false, decides: k } : given(args[k], k);
}

// Runners that start a command in a project's environment (choice 37): the subcommand that does it, if they have one, and
// their own options, from `uv run --help`, `uvx --help`, `npm exec --help` and `bunx --help` on this machine, and from
// pnpm's, pipenv's, poetry's and conda's documentation.
const UV: Options = {
  flags: "msUnqvhV",
  values: "wifPCpcb",
  long: [
    "all-extras", "no-dev", "only-dev", "no-default-groups", "all-groups", "module", "no-editable", "exact", "no-env-file", "isolated",
    "active", "no-sync", "locked", "frozen", "script", "gui-script", "all-packages", "no-project", "no-index", "upgrade", "no-sources",
    "reinstall", "compile-bytecode", "no-build-isolation", "no-build", "no-binary", "require-build-hashes", "no-require-build-hashes",
    "no-cache", "refresh", "managed-python", "no-managed-python", "no-python-downloads", "quiet", "verbose", "system-certs", "offline",
    "no-progress", "no-config", "lfs",
  ],
  longValues: [
    "extra", "no-extra", "group", "no-group", "only-group", "no-editable-package", "env-file", "with", "with-editable",
    "with-requirements", "package", "python-platform", "index", "default-index", "index-url", "extra-index-url", "find-links",
    "index-strategy", "keyring-provider", "upgrade-package", "upgrade-group", "resolution", "prerelease", "prerelease-package",
    "fork-strategy", "exclude-newer", "exclude-newer-package", "no-sources-package", "reinstall-package", "link-mode",
    "config-setting", "config-settings-package", "no-build-isolation-package", "no-build-package", "no-binary-package", "cache-dir",
    "refresh-package", "python", "color", "allow-insecure-host", "directory", "project", "config-file", "from", "constraints",
    "build-constraints", "overrides", "torch-backend",
  ],
};
const NPX: Options = {
  flags: "yqsdg",
  values: "pcw",
  long: [
    "yes", "no", "workspaces", "include-workspace-root", "quiet", "silent", "global", "offline", "prefer-offline", "prefer-online",
    "legacy-peer-deps", "force", "ignore-scripts", "no-install", "ignore-existing", // the last two from npx before npm 7, still taken
  ],
  longValues: ["package", "call", "workspace", "loglevel", "prefix", "registry", "cache", "userconfig"], // not --shell, the program
  // npx would run the -c text with, which the check does not follow
};
const PNPM: Options = {
  flags: "rwcs",
  values: "C",
  long: [
    "recursive", "parallel", "shell-mode", "report-summary", "reverse", "workspace-root", "no-reporter-hide-prefix", "silent", "stream",
    "aggregate-output",
  ],
  longValues: ["dir", "filter", "resume-from", "workspace-concurrency", "reporter", "package", "allow-build"],
};
const BUNX: Options = {
  flags: "",
  values: "p",
  long: ["bun", "no-install", "trust", "ignore-scripts", "verbose", "silent"],
  longValues: ["package", "cwd", "env-file", "minimum-release-age", "registry", "ca", "cafile"],
};
const PIPENV: Options = {
  flags: "qvh",
  values: "",
  long: ["where", "venv", "py", "envs", "rm", "bare", "man", "support", "site-packages", "no-site-packages", "clear", "quiet", "verbose", "system"],
  longValues: ["python", "pypi-mirror"],
};
const POETRY: Options = {
  flags: "qvnVh",
  values: "CP",
  long: ["quiet", "verbose", "no-interaction", "ansi", "no-ansi", "no-plugins", "no-cache"],
  longValues: ["directory", "project"],
};
const CONDA: Options = {
  flags: "vh",
  values: "np",
  long: ["verbose", "dev", "debug-wrapper-scripts", "no-capture-output", "live-stream"],
  longValues: ["name", "prefix", "cwd"],
};
const RUNNERS: Record<string, { sub?: string[]; options: Options }> = {
  uv: { sub: ["run"], options: UV },
  uvx: { options: UV },
  pipenv: { sub: ["run"], options: PIPENV },
  poetry: { sub: ["run"], options: POETRY },
  npx: { options: NPX },
  npm: { sub: ["exec", "x"], options: NPX },
  pnpm: { sub: ["exec", "dlx"], options: PNPM },
  bunx: { options: BUNX },
  conda: { sub: ["run"], options: CONDA },
};

// What a runner starts: its command's words; shell text for npx and npm exec's -c (read in sh's grammar and cmd's, as npm
// uses either by system) and pnpm's -c; or Python reading its code from the input, for `uv run -`. A runner given another
// subcommand (`npm install`, `uv pip`) starts nothing here.
function runner(name: string, args: Word[]): Wrapped[] {
  const { sub, options } = RUNNERS[name]!;
  const used = new Set<string>();
  let k = 0;
  if (sub) {
    if (!args.some((w) => sub.includes(w.value))) return [];
    k = skip(name, args, options, used);
    if (name === "uv" && args[k]?.value === "tool") k = skip(name, args, options, used, k + 1); // uv tool run, uvx's long form
    if (!sub.includes(args[k]?.value ?? "")) return [];
    k = skip(name, args, options, used, k + 1);
  } else k = skip(name, args, options, used);
  const rest = args.slice(k);
  const call = args.slice(0, k).findIndex((w) => /^(-c|--call)(=|$)/.test(w.value));
  if (call >= 0 && (name === "npx" || name === "npm")) {
    const word = args[call]!;
    const eq = word.value.indexOf("=");
    const text = eq >= 0 ? { value: word.value.slice(eq + 1), dynamic: word.dynamic } : args[call + 1];
    const runs = (grammar: Grammar): Runs => ({ grammar, texts: [text?.value ?? ""], dynamic: !!text?.dynamic });
    return [runs("bash"), runs("cmd")];
  }
  if (name === "pnpm" && (used.has("c") || used.has("shell-mode"))) {
    return [{ grammar: "bash", texts: [rest.map((w) => w.value).join(" ")], dynamic: rest.some((w) => w.dynamic) }];
  }
  if (rest.length === 0 || (name === "uv" && (used.has("m") || used.has("module")))) return [];
  if (rest[0]!.value === "-" && (name === "uv" || name === "uvx")) return [{ reads: CODE }];
  return [{ words: rest }];
}

// forfiles (`forfiles /?`): /p, /m and /d take a value, /s none, and /c gives the command line it runs for each file, by
// default "cmd /c echo @file", in which 0xHH stands for the character with that hex code. It starts the command with no
// shell between, so reading it in cmd's grammar finds every command it can run. Its @file and the like are words; a command
// named by one is named only when it runs.
function forfiles(args: Word[]): Wrapped[] {
  let text = "cmd /c echo @file";
  let dynamic = false;
  for (let k = 0; k < args.length; k++) {
    const option = /^[/-](.+)$/.exec(args[k]!.value)?.[1]?.toLowerCase();
    if (option === "p" || option === "m" || option === "d") k++;
    else if (option === "c") {
      const command = args[++k];
      text = command?.value ?? "";
      dynamic = !!command?.dynamic;
    } else if (option !== "s" && option !== "?") throw unknownOption("forfiles", args[k]!.value);
  }
  const decoded = text.replace(/0x([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (/^\s*@(file|fname|ext|path|relpath|isdir|fsize|fdate|ftime)\b/i.test(decoded)) throw new Unreadable(NAMED);
  return [{ grammar: "cmd", texts: [decoded], dynamic }];
}

// What a wrapper runs: a command's words (with what xargs or find put in them, the grammar they are read in, and the
// NAME=value words env or sudo set), shell text, or an interpreter reading its input.
type Wrapped = { words: Word[]; placeholder?: string; grammar?: Grammar; vars?: Word[] } | Runs | { reads: Hunger };

// What a command that runs the rest of its words runs (choice 34): the words, or for watch, shell text.
function wrapped(name: string, args: Word[], g: Grammar, src: string): Wrapped[] {
  if (name === "find") return execs(args).map((words) => ({ words, placeholder: "{}" }));
  if (name === "sudo" || name === "doas") {
    const { rest, vars } = sudoRun(name, args, g);
    return rest.length > 0 ? [{ words: rest, vars }] : [];
  }
  if (name === "wsl") {
    const run = wslRun(args);
    return "exec" in run && run.exec.length > 0 ? [{ words: run.exec, grammar: "bash" }] : []; // run in Linux, without a shell
  }
  if (name === "forfiles") return forfiles(args);
  if (name in RUNNERS) return runner(name, args);
  if (g === "cmd" && name === "call") return args.length > 0 ? [{ words: args }] : [];
  if (g === "cmd" && name === "start") return started(args, src);
  if (name === "sg") return sgRun(args);
  if (name === "script") return scriptRun(args);
  if (name === "parallel") return parallelRun(args);
  const options = WRAPPERS[name];
  if (!options) return [];
  const used = new Set<string>();
  let k = skip(name, args, options, used);
  const optionsEnd = k;
  if (name === "env") while (k < args.length && (args[k]!.value === "-" || args[k]!.value.includes("="))) k++;
  const given = (letter: string, ...names: string[]) => names.flatMap((n, i) => valuesOf(args, optionsEnd, options, i === 0 ? letter : "", n));
  // systemd-run's Exec... properties, and those that set the environment or the input (Environment=, EnvironmentFile=,
  // PassEnvironment=, StandardInput=), and strace's -o |command or !command, run text the check does not follow.
  const property = /^(exec|environment|passenvironment|standardinput)/i;
  const exec = name === "systemd-run" && given("p", "property", "path-property", "socket-property", "timer-property").some((w) => property.test(w.value));
  if (exec || (name === "strace" && given("o", "output").some((w) => /^[|!]/.test(w.value)))) throw new Unreadable(FOLLOW);
  // env's NAME=value words, and systemd-run's -E or --setenv and strace's -E or --env, set the command's environment.
  const setenv = name === "systemd-run" ? given("E", "setenv") : name === "strace" ? given("E", "env") : [];
  const vars = name === "env" ? args.slice(optionsEnd, k).filter((w) => w.value.includes("=")) : setenv.filter((w) => w.value.includes("="));
  if (name === "timeout") k++; // its duration
  if (name === "chroot" || name === "taskset" || name === "flock") k++; // the new root, the CPU mask, the lock's file
  if (name === "chrt" && /^\d+$/.test(args[k]?.value ?? "")) k++; // the priority, which newer versions need not be given
  const own = args.slice(0, k).map((w) => w.value);
  const rest = args.slice(k);
  if (STARTS_NONE[name]?.some((o) => used.has(o))) return [];
  // flock's `file -c text` gives the text to the user's shell.
  if (name === "flock" && ["-c", "--command"].includes(rest[0]?.value ?? "")) {
    return [{ grammar: "bash", texts: [rest[1]?.value ?? ""], dynamic: !!rest[1]?.dynamic }];
  }
  // With no command, unshare, chroot and systemd-run --shell start a shell, which reads the input.
  const shell = name === "unshare" || name === "chroot" || (name === "systemd-run" && (used.has("S") || used.has("shell")));
  if (rest.length === 0 && shell) return [{ reads: SHELL }];
  if (rest.length === 0 || (name === "command" && own.some((o) => /^-\w*[vV]/.test(o)))) return []; // command -v only names it
  if (name === "watch" && !own.some((o) => o === "--exec" || /^-\w*x/.test(o))) {
    return [{ grammar: "bash", texts: [rest.map((w) => w.value).join(" ")], dynamic: rest.some((w) => w.dynamic) }];
  }
  return [{ words: rest, placeholder: name === "xargs" ? replaced(own) : undefined, vars }];
}

// What xargs puts each input line in place of: -I's word, or {} for -i and --replace without one.
function replaced(own: string[]): string | undefined {
  let found: string | undefined;
  own.forEach((a, k) => {
    const short = /^-[0rtpxo]*([Ii])(.*)$/.exec(a);
    if (short) found = short[2] || (short[1] === "I" ? own[k + 1] : "{}");
    else if (a === "--replace") found = "{}";
    else if (a.startsWith("--replace=")) found = a.slice("--replace=".length);
  });
  return found;
}

// The values a command's own words (up to `end`, where skip() stopped) give one option, short `letter` or --`name`, read
// as skip() reads them.
function valuesOf(args: Word[], end: number, options: Options, letter: string, name?: string): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < end; k++) {
    const w = args[k]!;
    const a = w.value;
    if (a.startsWith("--")) {
      const [option = "", ...value] = a.slice(2).split("=");
      const given = value.length > 0 ? { ...w, value: value.join("=") } : options.longValues?.includes(option) ? args[++k] : undefined;
      if (option === name && given) out.push(given);
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const ch = a[j]!;
      if (!options.values.includes(ch) && !options.attached?.includes(ch)) continue;
      const given = j < a.length - 1 ? { ...w, value: a.slice(j + 1) } : options.values.includes(ch) ? args[++k] : undefined;
      if (ch === letter && given) out.push(given);
      break;
    }
  }
  return out;
}

// shadow's sg: `sg [-] group [-c] command`, the command given whole to /bin/sh -c; with none, it starts a shell, which
// reads the input.
function sgRun(args: Word[]): Wrapped[] {
  let k = args[0]?.value === "-" ? 1 : 0;
  if (args[k]?.value.startsWith("-")) throw unknownOption("sg", args[k]!.value);
  k++; // the group
  if (args[k]?.value === "-c") k++;
  const text = args[k];
  return text ? [{ grammar: "bash", texts: [text.value], dynamic: text.dynamic }] : [{ reads: SHELL }];
}

// util-linux's script (`script [options] [file]`) and BSD's (`script [options] [file [command ...]]`): -c gives shell text
// to the user's shell, and a command after the file is run itself; with neither, it starts a shell, which reads the input.
// util-linux also reads its options after the file, so a word there that it would read as -c makes the line unreadable.
function scriptRun(args: Word[]): Wrapped[] {
  const options = WRAPPERS.script!;
  const k = skip("script", args, options);
  const texts = valuesOf(args, k, options, "c", "command");
  const rest = args.slice(k + 1); // after the file
  const command = (a: string) => {
    if (a.startsWith("--")) return a.length > 2 && "command".startsWith(a.slice(2).split("=")[0]!);
    if (!a.startsWith("-")) return false;
    const letters = [...a.slice(1)];
    const at = letters.findIndex((ch) => !options.flags.includes(ch));
    return at >= 0 && letters[at] === "c";
  };
  const late = rest.find((w) => command(w.value));
  if (late) throw unknownOption("script", late.value);
  const out: Wrapped[] = [];
  if (texts.length > 0) out.push({ grammar: "bash", texts: texts.map((w) => w.value), dynamic: texts.some((w) => w.dynamic) });
  if (rest.length > 0) out.push({ words: rest });
  return out.length > 0 ? out : [{ reads: SHELL }];
}

// GNU parallel: `parallel [options] [command] ::: arguments`. It joins the command's words into shell text, as watch does,
// and runs it for each argument, put in place of {} (or -I's string), or after the text when it has none. The arguments of
// one ::: are on the line, so the text is read once with each, quoted as parallel quotes it, and, with an option that puts
// several in one command (-X, -m, -n, -N, -L, -s, --xargs and their long names), once with them all; those of one :::: or
// -a, or of the input, are left out, as xargs's are. Unreadable: {= ... =} anywhere (perl code); more than one list, or an argument
// known only when it runs, which the text cannot be filled with; another replacement string ({.}, {//}, {1} and the like),
// which changes the argument; and a command named by a replacement string. With no command, the arguments are the command
// lines.
const MARKS = [":::", "::::", ":::+", "::::+"];
const REPLACEMENT = /\{[\d.\/#%+]*\}/g;
const JOINS = ["X", "m", "n", "N", "L", "s", "xargs", "max-args", "max-lines", "max-chars"];
function parallelRun(args: Word[]): Wrapped[] {
  if (args.some((w) => w.value.includes("{="))) throw new Unreadable(FOLLOW);
  const options = WRAPPERS.parallel!;
  const used = new Set<string>();
  const k = skip("parallel", args, options, used);
  const marks = args.flatMap((w, i) => (i >= k && MARKS.includes(w.value) ? [i] : []));
  const after = marks.length === 1 && args[marks[0]!]!.value === ":::" ? args.slice(marks[0]! + 1) : [];
  if (marks.length + (used.has("a") || used.has("arg-file") ? 1 : 0) > 1 || after.some((w) => w.dynamic)) throw new Unreadable(MADE);
  const given = after.length > 0 ? after : undefined;
  const words = args.slice(k, marks[0]);
  if (words.length === 0) return [{ grammar: "bash", texts: given ? given.map((w) => w.value) : [""], dynamic: !given }];
  const repl = valuesOf(args, k, options, "I").at(-1)?.value ?? "{}";
  const text = words.map((w) => w.value).join(" ");
  if ((text.match(REPLACEMENT) ?? []).some((r) => r !== "{}")) throw new Unreadable(MADE);
  if (read(text, "bash", { env: [], cwd: KNOWN, positional: true }).commands.some((c) => (c.words[0] ?? "").includes(repl))) throw new Unreadable(NAMED);
  const dynamic = words.some((w) => w.dynamic);
  if (!given) return [{ grammar: "bash", texts: [text], dynamic }];
  const quoted = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const filled = (quotedArgs: string) => (text.includes(repl) ? text.split(repl).join(quotedArgs) : `${text} ${quotedArgs}`);
  const texts = given.map((w) => filled(quoted(w.value)));
  if (JOINS.some((o) => used.has(o))) texts.push(filled(given.map((w) => quoted(w.value)).join(" ")));
  return [{ grammar: "bash", texts, dynamic }];
}

// cmd's start: a window title in quotes first, then its switches, then the command.
function started(args: Word[], src: string): Wrapped[] {
  let k = args[0] && src[args[0].start] === '"' ? 1 : 0;
  for (; k < args.length; k++) {
    const a = args[k]!.value.toLowerCase();
    if (!a.startsWith("/")) break;
    if (START_VALUES.includes(a)) k++;
    else if (!START_FLAGS.includes(a) && !a.startsWith("/d")) throw unknownOption("start", args[k]!.value); // /dPATH
  }
  return k < args.length ? [{ words: args.slice(k) }] : [];
}

// Where a command's own options end, reading from word `from`; one it does not know makes the line unreadable. `used`
// collects the options given.
function skip(name: string, args: Word[], options: Options, used?: Set<string>, from = 0): number {
  let k = from;
  for (; k < args.length; k++) {
    const a = args[k]!.value;
    if (a === "--") return k + 1;
    if (a === "-" || !a.startsWith("-")) return k;
    if (a.startsWith("--")) {
      const option = a.slice(2).split("=")[0]!;
      used?.add(option);
      if (options.longValues?.includes(option)) {
        if (!a.includes("=")) k++;
        continue;
      }
      if (options.long?.includes(option) || option === "help" || option === "version") continue;
      throw unknownOption(name, a);
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]!;
      used?.add(letter);
      if (options.values.includes(letter)) {
        if (j === a.length - 1) k++;
        break;
      }
      if (options.attached?.includes(letter)) break;
      if (!options.flags.includes(letter)) throw unknownOption(name, a);
    }
  }
  return k;
}

// find's -exec, -execdir, -ok and -okdir run the words up to `;`, or up to `{} +`.
function execs(args: Word[]): Word[][] {
  const out: Word[][] = [];
  for (let k = 0; k < args.length; k++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[k]!.value)) continue;
    const from = k + 1;
    for (k = from; k < args.length; k++) {
      const value = args[k]!.value;
      if (value === ";" || (value === "+" && k > from && args[k - 1]!.value === "{}")) break;
    }
    if (k > from) out.push(args.slice(from, k));
  }
  return out;
}
