// Reads a shell command line into its separate commands, for the dangerous-command check (release 7 design, "The
// dangerous-command check"; plan, Task 2 and choices 2, 3, 32-35 and 37). Tachikoma's own reader: bash's grammar,
// PowerShell's, and cmd's for the text `cmd /c` runs. It is strict where it does not understand: anything it cannot read
// makes the whole line unreadable, which the check counts as dangerous.

export type Shell = "bash" | "powershell";
// `words` have their quotes taken off; `text` is the command as written, for the warning that names it.
export interface Command {
  words: string[];
  text: string;
}
export type Split = { commands: Command[] } | { unreadable: string }; // why, in plain words

// The shell a command runs in (choice 3): PowerShell on a Windows host, /bin/sh (read as bash) on any other, bash in the box.
export function shellOf(where: "host" | "box", platform: NodeJS.Platform = process.platform): Shell {
  return where === "host" && platform === "win32" ? "powershell" : "bash";
}

export function split(line: string, shell: Shell): Split {
  try {
    return { commands: once(read(line, shell).commands) };
  } catch (error) {
    if (error instanceof Unreadable) return { unreadable: error.message };
    // Brackets nested deeper than JavaScript's stack: no depth is set here, as none has a source.
    if (error instanceof RangeError) return { unreadable: DEEP };
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
type Stop = "" | ")" | "}"; // what closes the part being read: a bracket, or "" for the end of the text
interface Word {
  value: string; // quotes taken off
  start: number; // where it is in the text read
  end: number;
  dynamic: boolean; // holds a variable or a command's output, so it is known only when it runs
  shape: string; // bash: the word as written, with each quoted or escaped part as \0, for globs and brace expansion
}
// The commands read from a part of a line, and whether a shell among them reads the part's input: such a part fed a pipe,
// a here-document or a here-string runs text the check never sees.
interface Part {
  commands: Command[];
  hungry: boolean;
}
// What a shell is given to run: its text in a grammar, and whether that text is made only when the line runs.
interface Runs {
  grammar: Grammar;
  texts: string[];
  dynamic: boolean;
}

// Words before a command that are bash's own, not the command's; those that open and close a compound command.
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!"]);
const OPENS = new Set(["if", "while", "until", "for", "select"]);
const CLOSES = new Set(["fi", "done"]);
const SH = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh"]);
const OTHER_SHELLS = new Set(["fish", "csh", "tcsh"]);
// Programs whose words Windows PowerShell 5.1 passes with their inner double quotes changed (choice 37).
const REQUOTED = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "busybox", "cmd", "powershell", "pwsh"]);
// Files that are a process's own input.
const STDIN = new Set(["/dev/stdin", "/proc/self/fd/0", "/dev/fd/0"]);
// PowerShell's ways of running text or renaming a command that the check does not follow (choice 37).
const PS_FOLLOW = new Set(["start-process", "saps", "start", "set-alias", "new-alias", "sal", "nal"]);
const PS_FOLLOW_TEXT = /\[scriptblock\]::create|\.invokescript\s*\(|\.invokecommand\b/i;
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
const code = (n: number) => (n <= 0x10ffff ? String.fromCodePoint(n) : "");

function read(text: string, grammar: Grammar): Part {
  return new Reader(text.replace(/\r\n/g, "\n"), grammar).sequence("");
}

// A script block passed to powershell is read twice, as a block and as the shell's text: each command is kept once.
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
  hungry = false; // a shell in the brackets of the command being read reads that command's input

  constructor(
    private readonly src: string,
    private readonly g: Grammar,
  ) {
    this.escape = g === "bash" ? "\\" : g === "powershell" ? "`" : "^";
  }

  // Reads commands up to `stop`.
  sequence(stop: Stop): Part {
    const outer = this.pending;
    if (stop) {
      this.waiting += outer.length;
      this.pending = [];
    }
    const commands: Command[] = [];
    const open: boolean[] = []; // compound commands begun here (while, if, ...): whether each takes a pipe's input
    let hungry = false;
    let piped = false;
    let carried = false;
    for (;;) {
      const r = this.command(stop, carried);
      // A compound command after a pipe takes its input in every command inside it.
      const fed = piped || open.includes(true);
      if (r.hungry && fed) throw new Unreadable(PIPED);
      hungry ||= r.hungry;
      commands.push(...r.commands);
      for (let k = 0; k < r.opens; k++) open.push(fed);
      open.length = Math.max(0, open.length - r.closes);
      if (r.sep === stop) break;
      piped = r.sep === "|";
      carried = piped || r.sep === "&&" || r.sep === "||";
    }
    if (stop) {
      if (this.pending.length > 0) throw new Unreadable(HEREDOC); // its body would have to come after the bracket's end
      this.waiting -= outer.length;
      this.pending = outer;
    }
    return { commands, hungry };
  }

  // Reads one command, and the separator after it. `carried`: the line before ended in |, && or ||, so blank lines
  // before this command are skipped, as bash and PowerShell carry on to the next line.
  private command(stop: Stop, carried: boolean) {
    const { src, g } = this;
    const words: Word[] = [];
    const nested: Command[] = []; // the commands inside this one: $(...), backticks, brackets
    let start = -1;
    let last = -1;
    let group = false; // this command was a ( ) or { } group, which only redirections may follow
    let groupHungry = false;
    let named = false; // after bash's `function`: the name comes next
    let coproc = false; // after bash's `coproc`: a name may come before a group
    let called = false; // after PowerShell's & or .: the next word names the command
    let fed = false; // a here-document or here-string is this command's input
    let input = false; // a file is this command's input
    let opens = 0;
    let closes = 0;
    const outerHungry = this.hungry;
    this.hungry = false;
    const done = (sep: string) => {
      const own = this.emit(words, start, last);
      const subs = this.hungry; // $(...) and backticks read the line's input, not the command's
      this.hungry = outerHungry;
      const hungry = own.hungry || groupHungry;
      if (hungry && fed) throw new Unreadable(PIPED);
      return { commands: [...own.commands, ...nested], sep, hungry: (hungry && !input) || subs, opens, closes };
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
        if (start < 0) start = at;
        last = this.i;
        continue;
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
      const first = words.length === 0 && !group;
      if (c === "}" && (g === "powershell" || (g === "bash" && first && this.ends(next, stop)))) {
        if (stop !== "}") throw new Unreadable(UNPAIRED);
        this.i++;
        return done("}");
      }
      if (c === "(" && g === "bash") {
        // A function's definition, `name()`: its body is read as the next command.
        if (words.length <= 1 && !group && this.looking(/\(\s*\)/y)) {
          words.length = 0;
          start = -1;
          continue;
        }
        if (!first) throw new Unreadable(MISPLACED);
      }
      if ((c === "(" && g !== "powershell" && first) || (c === "{" && g === "bash" && first && /[ \t\n]/.test(next ?? ""))) {
        this.i++;
        const part = this.sequence(c === "(" ? ")" : "}");
        nested.push(...part.commands);
        groupHungry ||= part.hungry;
        group = true;
        last = this.i;
        continue;
      }
      if (c === "." && g === "powershell" && words.length === 0 && /[ \t]/.test(next ?? "")) {
        this.i++; // dot-sourcing, as in `. .\setup.ps1`
        called = true;
        continue;
      }
      const w = this.word(stop, nested);
      if (group) throw new Unreadable(MISPLACED);
      const raw = src.slice(w.start, w.end);
      if (g === "bash" && words.length === 0) {
        if (named) {
          named = false;
          continue;
        }
        if (coproc) {
          coproc = false;
          const name = /[ \t]*[{(]/y; // `coproc NAME { ...; }`: the name of a coprocess run from a group
          name.lastIndex = this.i;
          if (name.test(src)) continue;
        }
        if (raw === "coproc") coproc = true;
        if (raw === "function") named = true;
        if (OPENS.has(raw)) opens++;
        if (CLOSES.has(raw)) closes++;
        if (raw === "coproc" || raw === "function" || RESERVED.has(raw)) continue;
      }
      // After & or ., PowerShell runs whatever the word holds when the line runs (choice 37); a script block is read.
      if (called && words.length === 0 && w.dynamic) throw new Unreadable(NAMED);
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

  private emit(words: Word[], start: number, last: number): Part {
    const own = this.g === "bash" ? unassigned(words, this.src) : this.g === "powershell" ? psUnassigned(words) : cmdOwn(words);
    if (own.length === 0) return { commands: [], hungry: false };
    return expand(own, this.src.slice(start, last), this.src, this.g, false);
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
  // here-string is left out the same way (choice 35). Says what it was: "text" for a here-document or here-string, "input"
  // for a file read as the command's input, "file" for any other.
  private redirection(stop: Stop, nested: Command[]): "file" | "input" | "text" | false {
    const { src, g } = this;
    const re =
      g === "bash" ? /(\d*)(&>>|&>|>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)/y : g === "powershell" ? /([*\d]?)(>>|>|<)(&\d)?/y : /(\d?)(>>|>|<)(&\d)?/y;
    re.lastIndex = this.i;
    const m = re.exec(src);
    if (!m) return false;
    const op = m[2]!;
    const here = op.startsWith("<<");
    this.i = re.lastIndex;
    if (g === "bash" && src[this.i] === "(") throw new Unreadable(PROCESS);
    if (m[3]) return "file"; // 2>&1 and the like, which name no file
    while (src[this.i] === " " || src[this.i] === "\t") this.i++;
    if (this.ends(src[this.i], stop)) throw new Unreadable(here ? HEREDOC : NO_FILE);
    // A here-string's word is read as any word is, its $(...) and backticks included unless it is in single quotes.
    const w = this.word(stop, nested);
    // A quoted end word, as in <<'EOF', <<"EOF" or <<\EOF, keeps bash from expanding the body (bash manual, "Here Documents").
    if (op !== "<<<" && here) this.pending.push({ end: w.value, strip: op === "<<-", expands: !/['"\\]/.test(src.slice(w.start, w.end)) });
    if (here) return "text";
    return (op === "<" || op === "<>") && (m[1] === "" || m[1] === "0") ? "input" : "file";
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
        this.hungry ||= reader.hungry;
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
    this.hungry ||= part.hungry;
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
    while (!this.ends(src[this.i], stop)) {
      const c = src[this.i]!;
      if (c === this.escape) {
        const n = src[this.i + 1];
        this.i += n === undefined ? 1 : 2;
        value += n === "\n" ? "" : (n ?? c);
        shape += "\0";
      } else if (g === "bash") {
        shape += "'\"$`".includes(c) ? "\0" : c;
        value += this.bashPart(nested);
      } else value += g === "powershell" ? this.psPart(nested) : this.cmdPart();
    }
    const word = { value, start, end: this.i, dynamic: this.dynamic, shape };
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
    if (PS_SINGLE.has(c)) return this.psQuoted(PS_SINGLE);
    if (PS_DOUBLE.has(c)) return this.psQuoted(PS_DOUBLE, nested);
    if (c === "@" && this.looking(HERE_STRING)) return this.psHere(n!, nested);
    if (c === "(" || ((c === "$" || c === "@") && n === "(")) {
      this.i += c === "(" ? 1 : 2;
      this.inner(")", nested);
      this.dynamic = true;
      return src.slice(from, this.i);
    }
    if (c === "{" || (c === "@" && n === "{")) {
      this.i += c === "{" ? 1 : 2;
      this.inner("}", nested);
      return src.slice(from, this.i);
    }
    if (c === "$" && n === "{") return this.psBraced();
    if (c === "$" && /[\w:?^$]/.test(n ?? "")) this.dynamic = true;
    this.i++;
    return c;
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
      if (src[from + 2] === "(") {
        const kept = nested.length;
        this.i = from + 3;
        if (this.arithmetic(nested)) return src.slice(from, this.i);
        nested.length = kept; // $( (...) ...), a command after all, as bash reads it
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
    if (n === "'" && !quoted) return this.ansi();
    if (n === '"' && !quoted) {
      this.i++;
      return this.bashDouble(nested);
    }
    if (/[\w@*#?$!-]/.test(n ?? "")) this.dynamic = true; // $name, $1, $@ and bash's other special parameters
    this.i++;
    return "$";
  }

  // $((...)): arithmetic, whose only commands are in its own $(...) and backticks. False when it turns out to be $( (...) ).
  private arithmetic(nested: Command[]): boolean {
    const { src } = this;
    let depth = 0;
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNPAIRED);
      if (c === ")" && depth === 0) {
        if (src[this.i + 1] !== ")") return false;
        this.i += 2;
        return true;
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
    for (;;) {
      const c = src[this.i];
      if (c === undefined) throw new Unreadable(UNPAIRED);
      if (c === "}") {
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
      if (hex) value += code(parseInt(hex, 16));
      else if (m[4]) value += code(parseInt(m[4], 8));
      else if (m[5]) value += code(m[5].charCodeAt(0) % 32); // a control character is its letter's code modulo 32 (ASCII)
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
    this.hungry ||= part.hungry;
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
      return code(parseInt(m[1]!, 16));
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
          this.hungry ||= reader.hungry;
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

// Leading NAME=value words only set variables for the command after them (choice 33). Read from the word as written, so a
// quoted "FOO=1" is a command's name.
function unassigned(words: Word[], src: string): Word[] {
  let k = 0;
  while (k < words.length && /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(src.slice(words[k]!.start, words[k]!.end))) k++;
  return words.slice(k);
}

// PowerShell's `$x = <command>` and `$x, $y = <command>` run the command: the variables and the = are left out, as bash's
// NAME=value is.
const PS_OPERATOR = /^([-+*/%]|\?\?)?=$/;
const psTargets = (v: string) => /\$|^,$/.test(v) && v.split(",").every((p) => p === "" || /^(\[[^\]]*\])*\$[^=]*$/.test(p));
function psUnassigned(words: Word[]): Word[] {
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
    words = rest ? [{ ...w, value: rest, start: w.end - rest.length }, ...words.slice(k + 1)] : words.slice(k + 1);
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

// A command's name without its folder or .exe, in lower case, as Windows finds it.
function nameOf(word: string): string {
  return word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
}

// A command, then what it runs: the text it gives a shell (choice 2), or the command in the rest of its words (choice 34).
// `inner`: the command is in another's words, as in `env rm`, so its name is a program's whatever the grammar.
// `placeholder`: what xargs -I or find -exec replaces in the words when it runs.
function expand(words: Word[], text: string, src: string, g: Grammar, inner: boolean, placeholder?: string): Part {
  const [first, ...args] = words as [Word, ...Word[]];
  const name = nameOf(first.value);
  // A name known only when the line runs: a variable, a command's output, a glob, a brace expansion, or a placeholder.
  // PowerShell's own are checked after & and . (Reader.command); a first word there is an expression, not a name.
  const glob = g === "bash" && /\{[^{}]*(,|\.\.)[^{}]*\}|[*?]|\[[^\]]*\]/.test(first.shape);
  if (((g === "bash" || inner) && first.dynamic) || glob || (placeholder && first.value.includes(placeholder))) throw new Unreadable(NAMED);
  if (g === "bash" && name === "eval") throw new Unreadable(EVAL);
  if (g === "powershell" && (name === "iex" || name === "invoke-expression")) throw new Unreadable(IEX);
  if (g === "powershell" && PS_FOLLOW.has(name)) throw new Unreadable(FOLLOW);
  if (g === "powershell" && REQUOTED.has(name) && args.some((a) => a.value.includes('"'))) {
    throw requoted(first.value.replace(/^.*[\\/]/, "").replace(/\.exe$/i, ""));
  }
  const commands: Command[] = [{ words: words.map((w) => w.value), text }];
  let hungry = false;
  const run = (runs: Runs) => {
    if (runs.dynamic || (placeholder && runs.texts.some((t) => t.includes(placeholder)))) throw new Unreadable(MADE);
    for (const t of runs.texts) {
      const part = read(t, runs.grammar);
      commands.push(...part.commands);
      hungry ||= part.hungry; // the shell's own commands read its input
    }
  };
  const runs = shellRuns(name, args, g);
  if (runs === undefined) hungry = true;
  else if (runs) run(runs);
  for (const w of wrapped(name, args, g, src)) {
    if ("grammar" in w) {
      run(w);
      continue;
    }
    const part = expand(w.words, src.slice(w.words[0]!.start, w.words.at(-1)!.end), src, g, true, w.placeholder ?? placeholder);
    // xargs gives the command its input, so a shell there runs it.
    if (name === "xargs" && part.hungry) throw new Unreadable(PIPED);
    commands.push(...part.commands);
    hungry ||= part.hungry;
  }
  return { commands, hungry };
}

// The text a command gives a shell to run; null when it gives none; undefined when the shell reads its input, as in
// `curl x | sh`, and runs what comes down the pipe.
function shellRuns(name: string, args: Word[], g: Grammar): Runs | null | undefined {
  if (SH.has(name)) return shText(args);
  if (name === "cmd") return cmdText(args);
  if (name === "powershell" || name === "pwsh") return psText(name, args);
  if (OTHER_SHELLS.has(name)) return otherShell(args);
  if (g === "bash" && name === "trap") return trapText(args);
  if (g === "bash" && (name === "source" || name === ".") && STDIN.has(args[0]?.value ?? "")) return undefined;
  return null;
}

// What bash, sh, zsh, dash, ksh or mksh runs: the text after -c, null for a script file, undefined when it reads its input:
// with no script, with -s, or with its own input as the script. Without its text, -c runs what xargs gives it.
function shText(args: Word[]): Runs | null | undefined {
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
  if (c) return text && { grammar: "bash", texts: [text.value], dynamic: text.dynamic };
  return s || !text || STDIN.has(text.value) ? undefined : null;
}

// fish, csh and tcsh: text given to them (-c; fish's -C, --command and --init-command) is in a grammar the check does not
// read; with no script they read their input.
function otherShell(args: Word[]): null | undefined {
  for (const { value } of args) {
    if (/^--(init-)?command/.test(value) || /^-[^-]*[cC]/.test(value)) throw new Unreadable(OTHER);
    if (!value.startsWith("-")) return STDIN.has(value) ? undefined : null;
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
    return text === "" || text === "-" ? undefined : { grammar: "powershell", texts: [text], dynamic: words.some((w) => w.dynamic) };
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
// %NAME% is filled in before cmd reads the text, so text holding one is made only when it runs.
function cmdText(args: Word[]): Runs | undefined {
  const line = args.map((w) => w.value).join(" ");
  const m = /\/[ckr]/i.exec(line);
  if (!m) return undefined;
  const text = line.slice(m.index + 2).replace(/^[ \t]+/, "");
  const dynamic = args.some((w) => w.dynamic) || /%[^%\s]+%/.test(text);
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
};
// cmd's start (`start /?`): switches on their own, and those that take the next word.
const START_FLAGS = ["/i", "/min", "/max", "/separate", "/shared", "/low", "/normal", "/high", "/realtime", "/abovenormal", "/belownormal", "/wait", "/b"];
const START_VALUES = ["/d", "/node", "/affinity", "/machine"];

type Wrapped = { words: Word[]; placeholder?: string } | Runs;

// What a command that runs the rest of its words runs (choice 34): the words, or for watch, shell text.
function wrapped(name: string, args: Word[], g: Grammar, src: string): Wrapped[] {
  if (name === "find") return execs(args).map((words) => ({ words, placeholder: "{}" }));
  if (g === "cmd" && name === "call") return args.length > 0 ? [{ words: args }] : [];
  if (g === "cmd" && name === "start") return started(args, src);
  const options = WRAPPERS[name];
  if (!options) return [];
  let k = skip(name, args, options);
  if (name === "env") while (k < args.length && (args[k]!.value === "-" || args[k]!.value.includes("="))) k++;
  if (name === "timeout") k++; // its duration
  const own = args.slice(0, k).map((w) => w.value);
  const rest = args.slice(k);
  if (rest.length === 0 || (name === "command" && own.some((o) => /^-\w*[vV]/.test(o)))) return []; // command -v only names it
  if (name === "watch" && !own.some((o) => o === "--exec" || /^-\w*x/.test(o))) {
    return [{ grammar: "bash", texts: [rest.map((w) => w.value).join(" ")], dynamic: rest.some((w) => w.dynamic) }];
  }
  return [{ words: rest, placeholder: name === "xargs" ? replaced(own) : undefined }];
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

// Where a command's own options end; one it does not know makes the line unreadable.
function skip(name: string, args: Word[], options: Options): number {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!.value;
    if (a === "--") return k + 1;
    if (a === "-" || !a.startsWith("-")) return k;
    if (a.startsWith("--")) {
      const option = a.slice(2).split("=")[0]!;
      if (options.longValues?.includes(option)) {
        if (!a.includes("=")) k++;
        continue;
      }
      if (options.long?.includes(option) || option === "help" || option === "version") continue;
      throw unknownOption(name, a);
    }
    for (let j = 1; j < a.length; j++) {
      const letter = a[j]!;
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
