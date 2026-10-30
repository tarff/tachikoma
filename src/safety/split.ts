// Reads a shell command line into its separate commands, for the dangerous-command check (release 7 design, "The
// dangerous-command check"; plan, Task 2 and choices 2, 3 and 32-34). Tachikoma's own reader: bash's grammar, PowerShell's,
// and cmd's for the text `cmd /c` runs. It is strict where it does not understand: anything it cannot read makes the whole
// line unreadable, which the check counts as dangerous.

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
    return { commands: once(read(line, shell)) };
  } catch (error) {
    if (error instanceof Unreadable) return { unreadable: error.message };
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
const unknownOption = (name: string, option: string) => new Unreadable(`${name} ${option}, an option the check does not read`);

type Grammar = Shell | "cmd";
type Stop = "" | ")" | "}"; // what closes the part being read: a bracket, or "" for the end of the text
interface Word {
  value: string; // quotes taken off
  start: number; // where it is in the text read
  end: number;
}

// Words before a command that are bash's own, not the command's.
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!"]);
const SH = new Set(["bash", "sh", "zsh", "dash"]);
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

function read(text: string, grammar: Grammar): Command[] {
  return new Reader(text.replace(/\r\n/g, "\n"), grammar).sequence("", false);
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
  private pending: HereDoc[] = [];

  constructor(
    private readonly src: string,
    private readonly g: Grammar,
  ) {
    this.escape = g === "bash" ? "\\" : g === "powershell" ? "`" : "^";
  }

  // Reads commands up to `stop`. `receives`: this part's input is a pipe, so a shell in it would run what comes down it.
  sequence(stop: Stop, receives: boolean): Command[] {
    const out: Command[] = [];
    let piped = false;
    for (;;) {
      const { commands, sep } = this.command(stop, receives || piped);
      out.push(...commands);
      if (sep === stop) return out;
      piped = sep === "|";
    }
  }

  // Reads one command, and the separator after it.
  private command(stop: Stop, receives: boolean): { commands: Command[]; sep: string } {
    const { src, g } = this;
    const words: Word[] = [];
    const nested: Command[] = []; // the commands inside this one: $(...), backticks, brackets
    let start = -1;
    let last = -1;
    let group = false; // this command was a ( ) or { } group, which only redirections may follow
    let named = false; // after bash's `function`: the name comes next
    let fed = false; // a here-document or here-string is this command's input, so a shell here would run it
    const done = (sep: string) => ({ commands: this.emit(words, nested, start, last, receives || fed), sep });
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
        if (start < 0) start = at;
        last = this.i;
        continue;
      }
      if (c === "\n" || (c === ";" && g !== "cmd")) {
        this.i++;
        if (c === "\n") nested.push(...this.bodies());
        return done(c);
      }
      if (c === "&" || c === "|") {
        const two = src.slice(at, at + 2);
        if (two === "&&" || two === "||" || (two === "|&" && g === "bash")) {
          this.i += 2;
          return done(two === "|&" ? "|" : two);
        }
        this.i++;
        if (c === "&" && g === "powershell" && words.length === 0) continue; // the call operator, as in `& 'name'`
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
        nested.push(...this.sequence(c === "(" ? ")" : "}", receives));
        group = true;
        last = this.i;
        continue;
      }
      if (c === "." && g === "powershell" && words.length === 0 && /[ \t]/.test(next ?? "")) {
        this.i++; // dot-sourcing, as in `. .\setup.ps1`
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
        if (raw === "function") named = true;
        if (raw === "function" || RESERVED.has(raw)) continue;
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

  private emit(words: Word[], nested: Command[], start: number, last: number, receives: boolean): Command[] {
    const own = this.g === "bash" ? unassigned(words, this.src) : this.g === "powershell" ? psUnassigned(words) : cmdOwn(words);
    if (own.length === 0) return nested;
    return [...expand(own, this.src.slice(start, last), this.src, this.g, receives), ...nested];
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
  // here-string is left out the same way (choice 35); "text" says one is the command's input.
  private redirection(stop: Stop, nested: Command[]): "file" | "text" | false {
    const { src, g } = this;
    const re =
      g === "bash" ? /\d*(&>>|&>|>>|>&|>\||>|<<<|<<-|<<|<&|<>|<)/y : g === "powershell" ? /[*\d]?(>>|>|<)(&\d)?/y : /\d?(>>|>|<)(&\d)?/y;
    re.lastIndex = this.i;
    const m = re.exec(src);
    if (!m) return false;
    const op = m[1]!;
    const here = op.startsWith("<<");
    this.i = re.lastIndex;
    if (g === "bash" && src[this.i] === "(") throw new Unreadable(PROCESS);
    if (m[2]) return "file"; // 2>&1 and the like, which name no file
    while (src[this.i] === " " || src[this.i] === "\t") this.i++;
    if (this.ends(src[this.i], stop)) throw new Unreadable(here ? HEREDOC : NO_FILE);
    // A here-string's word is read as any word is, its $(...) and backticks included unless it is in single quotes.
    const w = this.word(stop, nested);
    // A quoted end word, as in <<'EOF', <<"EOF" or <<\EOF, keeps bash from expanding the body (bash manual, "Here Documents").
    if (op !== "<<<" && here) this.pending.push({ end: w.value, strip: op === "<<-", expands: !/['"\\]/.test(src.slice(w.start, w.end)) });
    return here ? "text" : "file";
  }

  // Reads the bodies of the here-documents begun on the line just ended, and returns the commands in those bash expands.
  private bodies(): Command[] {
    const { src } = this;
    const out: Command[] = [];
    for (const doc of this.pending) {
      const from = this.i;
      for (;;) {
        if (this.i >= src.length) throw new Unreadable(HEREDOC); // its end line never came
        const newline = src.indexOf("\n", this.i);
        const lineEnd = newline < 0 ? src.length : newline;
        const line = src.slice(this.i, lineEnd);
        const bodyEnd = this.i;
        this.i = newline < 0 ? src.length : newline + 1;
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.end) {
          if (doc.expands) out.push(...new Reader(src.slice(from, bodyEnd), "bash").expansions());
          break;
        }
      }
    }
    this.pending = [];
    return out;
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
        nested.push(...this.sequence(")", false));
      } else this.i++;
    }
    return nested;
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
      words.push({ value: m[1]!.replace(/"/g, ""), start: this.i - m[1]!.length, end: this.i });
    }
  }

  // Reads one word: its value has the quotes taken off, and the commands inside it are added to `nested`.
  private word(stop: Stop, nested: Command[]): Word {
    const { src, g } = this;
    const start = this.i;
    let value = "";
    while (!this.ends(src[this.i], stop)) {
      const c = src[this.i]!;
      if (c === this.escape) {
        const n = src[this.i + 1];
        this.i += n === undefined ? 1 : 2;
        value += n === "\n" ? "" : (n ?? c);
      } else value += g === "bash" ? this.bashPart(nested) : g === "powershell" ? this.psPart(nested) : this.cmdPart();
    }
    return { value, start, end: this.i };
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
      nested.push(...this.sequence(")", false));
      return src.slice(from, this.i);
    }
    if (c === "{" || (c === "@" && n === "{")) {
      this.i += c === "{" ? 1 : 2;
      nested.push(...this.sequence("}", false));
      return src.slice(from, this.i);
    }
    if (c === "$" && n === "{") return this.psBraced();
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

  // bash's $ forms that hold code or quotes: $(...), $((...)), ${...}, $'...' and $"..."; any other $ is an ordinary character.
  private dollar(nested: Command[], quoted: boolean): string {
    const { src } = this;
    const from = this.i;
    const n = src[from + 1];
    if (n === "(") {
      if (src[from + 2] === "(") {
        const kept = nested.length;
        this.i = from + 3;
        if (this.arithmetic(nested)) return src.slice(from, this.i);
        nested.length = kept; // $( (...) ...), a command after all, as bash reads it
      }
      this.i = from + 2;
      nested.push(...this.sequence(")", false));
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
    nested.push(...read(inner, "bash"));
    return src.slice(from, this.i);
  }

  // PowerShell's quotes: any of its quote marks of the kind closes the string, and two together stand for one. Double
  // quotes (`nested` given) also read backtick escapes, $(...) and ${...}.
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
        nested.push(...this.sequence(")", false));
        value += src.slice(from, this.i);
      } else if (nested && c === "$" && n === "{") value += this.psBraced();
      else {
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
        if (marks === PS_DOUBLE) nested.push(...new Reader(body, "powershell").expansions());
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

// PowerShell's `$x = <command>` runs the command: the variable and its = are left out, as bash's NAME=value is.
function psUnassigned(words: Word[]): Word[] {
  for (;;) {
    const [first, second] = words;
    if (!first || !/^(\[[^\]]*\])*\$/.test(first.value)) return words;
    if (!first.value.includes("=") && second && /^([-+*/%]|\?\?)?=$/.test(second.value)) {
      words = words.slice(2);
      continue;
    }
    const joined = /^[^=\s]*?(?:[-+*/%]|\?\?)?=([\s\S]*)$/.exec(first.value);
    if (!joined) return words;
    const rest = joined[1]!;
    words = rest ? [{ value: rest, start: first.end - rest.length, end: first.end }, ...words.slice(1)] : words.slice(1);
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
function expand(words: Word[], text: string, src: string, g: Grammar, receives: boolean): Command[] {
  const [first, ...args] = words as [Word, ...Word[]];
  const name = nameOf(first.value);
  if (g === "bash" && name === "eval") throw new Unreadable(EVAL);
  if (g === "powershell" && (name === "iex" || name === "invoke-expression")) throw new Unreadable(IEX);
  const out: Command[] = [{ words: words.map((w) => w.value), text }];
  const shell = SH.has(name) ? "bash" : name === "cmd" ? "cmd" : name === "powershell" || name === "pwsh" ? "powershell" : undefined;
  if (shell) {
    const runs = shell === "bash" ? shText(args) : shell === "cmd" ? cmdText(args) : psText(name, args);
    if (runs === undefined && receives) throw new Unreadable(PIPED);
    if (runs) out.push(...read(runs, shell));
  }
  for (const inner of wrapped(name, args)) {
    if (typeof inner === "string") out.push(...read(inner, "bash"));
    // xargs gives the command its input as words; find's commands get none of find's.
    else out.push(...expand(inner, src.slice(inner[0]!.start, inner.at(-1)!.end), src, g, name === "xargs" || (name !== "find" && receives)));
  }
  return out;
}

// What bash, sh, zsh or dash runs: the text after -c, null for a script file, undefined when it reads its input
// (`curl x | sh`). Without its text, -c runs what it is given on its input, as from xargs.
function shText(args: Word[]): string | null | undefined {
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
  if (c) return args[k]?.value;
  return s || k >= args.length ? undefined : null;
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
// a parameter; null for -File; undefined when it reads its input.
function psText(name: string, args: Word[]): string | null | undefined {
  const rest = (from: number) => {
    const text = args.slice(from).map((w) => w.value).join(" ");
    return text === "" || text === "-" ? undefined : text;
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
    if (kind === "file") return null;
    if (kind === "command") return rest(k + 1);
    if (kind === "commandwithargs") return args[k + 1]?.value;
    if (kind === "value") k++;
  }
  return undefined;
}

// What cmd runs: the words after /c or /k (/r is /c), undefined when it reads its input. Its other switches (/s, /q, /d,
// /e:on and the like) are skipped.
function cmdText(args: Word[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!.value.toLowerCase();
    if (a === "/c" || a === "/k" || a === "/r") return args.slice(k + 1).map((w) => w.value).join(" ");
    if (!/^\/[a-z](:.*)?$/.test(a)) return undefined;
  }
  return undefined;
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
// (xargs), GNU time 1.9, procps-ng 4.0 (watch), and bash's help for exec and command.
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
  xargs: {
    flags: "0rtpxo",
    values: "adEILnPs",
    attached: "eil",
    long: ["null", "no-run-if-empty", "verbose", "interactive", "exit", "open-tty", "show-limits", "eof", "replace"],
    longValues: ["arg-file", "delimiter", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var"],
  },
  watch: {
    flags: "bcCdegprtwxhv",
    values: "nqs",
    long: ["beep", "color", "no-color", "differences", "errexit", "chgexit", "precise", "no-rerun", "no-title", "no-wrap", "exec"],
    longValues: ["interval", "equexit", "shotsdir"],
  },
};

// What a command that runs the rest of its words runs (choice 34): the words, or for watch, shell text.
function wrapped(name: string, args: Word[]): (Word[] | string)[] {
  if (name === "find") return execs(args);
  const options = WRAPPERS[name];
  if (!options) return [];
  let k = skip(name, args, options);
  if (name === "env") while (k < args.length && (args[k]!.value === "-" || args[k]!.value.includes("="))) k++;
  if (name === "timeout") k++; // its duration
  const own = args.slice(0, k).map((w) => w.value);
  const rest = args.slice(k);
  if (rest.length === 0 || (name === "command" && own.some((o) => /^-\w*[vV]/.test(o)))) return []; // command -v only names it
  if (name === "watch" && !own.some((o) => o === "--exec" || /^-\w*x/.test(o))) return [rest.map((w) => w.value).join(" ")];
  return [rest];
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
