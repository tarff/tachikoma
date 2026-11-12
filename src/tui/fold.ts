import { visible } from "../core/permissions.js";
import type { Message, ToolCall, ToolResult } from "../core/types.js";
import { isMcp } from "../hooks/tools.js";
import { safeName } from "../mcp/config.js";
import { SEARCH } from "../mcp/search.js";
import type { Servers } from "../mcp/servers.js";
import { type Shell, split } from "../safety/split.js";
import { brief, callRow, describe, type Line, resultRow } from "./describe.js";
import { elapsed } from "./WorkingLine.js";

// Folded tool rows, as Claude Code's (release 8c plan, choice 65; Task 15): calls with no text between them that only
// read, search, list or run a read-only command are one grey row of counts, said once the run ends, so no row is ever
// changed after it is said, in full screen and in --classic alike.

type Counted = "search" | "read" | "list" | "called" | "ran";
export type Kind = Counted | "hidden" | "own";

// What a run's calls are counted by: the asked calls (Session.asked), the shell the shell tool runs in (split.ts,
// shellOf), and a server's name as its settings give it, from the name its tools carry.
export interface FoldOptions {
  asked: ReadonlySet<string>;
  shell: Shell;
  server: (safe: string) => string;
}

// A server's settings name from its safe one, or the safe one for a server no longer set up.
export const serverNames = (servers?: Pick<Servers, "list">) => (safe: string) => servers?.list().find((s) => safeName(s.name) === safe)?.name ?? safe;

// The shell lists (Task 15), Tachikoma's own, as Claude Code's could not be read; each shell's, PowerShell's in lower case,
// as it takes its names in any. `git` is the same program in either, so it is read the same way in both.
type Listed = "read" | "list" | "search" | "ran";
const LISTS: Record<Shell, Record<Listed, readonly string[]>> = {
  bash: {
    read: ["cat", "head", "tail", "wc"],
    list: ["ls", "dir"],
    search: ["grep", "rg", "find", "fd"],
    ran: ["cd", "pwd", "echo", "printf", "which", "where", "whoami", "date", "true"],
  },
  powershell: {
    read: ["get-content", "gc", "type", "cat", "measure-object"],
    list: ["get-childitem", "gci", "ls", "dir"],
    search: ["select-string", "sls"],
    // cd, pwd and echo: Set-Location's, Get-Location's and Write-Output's names (the user's choice, 2026-11-12).
    ran: ["set-location", "get-location", "write-output", "get-command", "test-path", "get-item", "cd", "pwd", "echo"],
  },
};
const GIT_READS = ["log", "status", "diff", "show", "rev-parse", "branch", "remote", "ls-files"];
// The options that make a listed command write or run another (finding 3 of the plan review).
const FIND_ACTIONS = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
const FD_EXEC = ["--exec", "--exec-batch"];

// One command's kind, by its first word, or null when it is on no list or one of its options writes.
function commandKind(words: string[], shell: Shell): Listed | null {
  const name = shell === "powershell" ? words[0]!.toLowerCase() : words[0]!;
  const rest = words.slice(1);
  if (name === "git") {
    // An option before the subcommand (-c, -C, --git-dir, --work-tree among them) is not read: it is never a plain read.
    const [sub, ...after] = rest;
    if (sub === undefined || !GIT_READS.includes(sub) || rest.some((w) => w.startsWith("--output") || w.startsWith("--ext-diff"))) return null;
    if (sub === "branch" && after.length) return null;
    if (sub === "remote" && !(after.length === 0 || (after.length === 1 && after[0] === "-v"))) return null;
    return "ran";
  }
  if (shell === "bash" && name === "find" && rest.some((w) => FIND_ACTIONS.includes(w))) return null;
  // fd's short options can be joined, as -Hx.
  const fdExec = (w: string) => FD_EXEC.some((o) => w === o || w.startsWith(`${o}=`)) || /^-[A-Za-z]*[xX][A-Za-z]*$/.test(w);
  if (shell === "bash" && name === "fd" && rest.some(fdExec)) return null;
  if (shell === "bash" && name === "rg" && rest.some((w) => w.startsWith("--pre"))) return null;
  // date -s (alone or among short options) or --set sets the clock; printf -v sets a variable (the quality review).
  if (shell === "bash" && name === "date" && rest.some((w) => /^-[A-Za-z]*s/.test(w) || /^--set(=|$)/.test(w))) return null;
  if (shell === "bash" && name === "printf" && rest.some((w) => w.startsWith("-v"))) return null;
  const lists = LISTS[shell];
  return (["read", "list", "search", "ran"] as const).find((k) => lists[k].includes(name)) ?? null;
}

// A redirection to a file, a command substitution, process substitution or script block, or a variable set, anywhere in
// the line, which makes it its own row whatever its commands (Task 15). split reads these without saying so in its
// commands, and leaves out a bash NAME=value word, which can change what a command runs (LD_PRELOAD, GIT_EXTERNAL_DIFF,
// BASH_ENV, PATH; the quality review), so the line's text is looked at: a quoted ">" or "$(" counts too, which only keeps
// a row that could have folded. Errors thrown away (2>/dev/null, PowerShell's 2>$null) or joined to the output (2>&1)
// write no file (the user's choice, 2026-11-12).
const END = String.raw`(?=$|[\s;|&)])`;
const QUIET = { bash: new RegExp(String.raw`2>\s*/dev/null${END}|2>&1${END}`, "g"), powershell: new RegExp(String.raw`2>\s*\$null${END}|2>&1${END}`, "g") };
// bash takes one wherever a command starts: after a separator, `!`, `{` or a keyword (time with or without -p), an
// array's element too (the quality review's re-check).
const STARTS = String.raw`(?:^|[;&|(){}\n!]|(?<![\w-])(?:if|then|else|elif|do|while|until|time(?:\s+-p)?)(?=\s))`;
const ASSIGNS = { bash: new RegExp(String.raw`${STARTS}\s*[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=`), powershell: /\$[\w:.]+\s*[-+*/%]?=/ };
function writesOrRuns(line: string, shell: Shell): boolean {
  const text = line.replace(QUIET[shell], "");
  if (text.includes(">") || ASSIGNS[shell].test(text)) return true;
  return shell === "bash" ? /\$\(|`|<\(/.test(text) : /\$\(|@\(|\{/.test(text);
}

// A shell line's kinds: one for a line whose commands are all of one kind of the read, list and search lists, each
// command's for a mix of them, and "ran" for one with any of the "ran" list among them; null when it is its own row
// (measured on Claude Code: `cat a && cat b` = Read 1 file, `cd ... && git log` = Ran 1 shell command, `rm` kept its row).
export function shellKinds(line: string, shell: Shell): Listed[] | null {
  if (writesOrRuns(line, shell)) return null;
  const s = split(line, shell);
  if ("unreadable" in s || !s.all.length) return null;
  const kinds = s.all.map((c) => (c.words.length ? commandKind(c.words, shell) : null));
  if (kinds.some((k) => k === null)) return null;
  if (kinds.includes("ran")) return ["ran"];
  return new Set(kinds).size === 1 ? [kinds[0]!] : (kinds as Listed[]);
}

// A call's kinds (Task 15): one for most; a shell line's from shellKinds. A call that asked the user a question, whatever
// the answer, or failed is its own row, whatever its tool: its answer's line sits under its row, and a failure's red
// first line stays seen.
export function kindOf(call: ToolCall, asked: ReadonlySet<string>, failed: boolean, shell: Shell): Kind[] {
  if (asked.has(call.id) || failed) return ["own"];
  if (call.name === "read_file") return ["read"];
  if (call.name === "find_files" || call.name === "search_files") return ["search"];
  if (call.name === SEARCH) return ["hidden"];
  if (isMcp(call.name)) return ["called"];
  const command = call.name === "shell" && typeof call.input === "object" && call.input !== null ? (call.input as { command?: unknown }).command : undefined;
  return (typeof command === "string" && shellKinds(command, shell)) || ["own"];
}

// The server part of mcp__<server>__<tool>, which holds no "__" (config.ts).
const safeOf = (name: string) => name.slice(5, name.indexOf("__", 5));

// The row's words (choice 65): the kinds present, in Claude Code's order, joined by ", ", the first word capitalised;
// null for a run with none to count.
export function rowText(calls: readonly { call: ToolCall; kinds: Kind[] }[], server: (safe: string) => string): string | null {
  const n: Record<Exclude<Counted, "called">, number> = { search: 0, read: 0, list: 0, ran: 0 };
  const called = new Map<string, number>(); // in the order first called
  for (const { call, kinds } of calls) {
    for (const k of kinds) {
      if (k === "called") {
        const name = visible(server(safeOf(call.name)));
        called.set(name, (called.get(name) ?? 0) + 1);
      } else if (k !== "hidden" && k !== "own") n[k]++;
    }
  }
  const s = (count: number) => (count === 1 ? "" : "s");
  const parts = [
    ...(n.search ? [`searched for ${n.search} pattern${s(n.search)}`] : []),
    ...(n.read ? [`read ${n.read} file${s(n.read)}`] : []),
    ...(n.list ? [`listed ${n.list} director${n.list === 1 ? "y" : "ies"}`] : []),
    ...[...called].map(([name, count]) => `called ${name}${count > 1 ? ` ${count} times` : ""}`),
    ...(n.ran ? [`ran ${n.ran} shell command${s(n.ran)}`] : []),
  ];
  if (!parts.length) return null;
  const text = parts.join(", ");
  return text[0]!.toUpperCase() + text.slice(1);
}

// A said folded row: its words, its calls with their result rows as they arrive, for opening, and whether it is open. The
// rows, not the results, so a fold holds no read's whole text once a shortening has let the messages go.
export interface Fold {
  text: string;
  calls: { call: ToolCall; kinds: Kind[] }[];
  results: Map<string, Line>;
  open: boolean;
}

// A folded row opened (full screen, a click): its calls' rows as they look unfolded, each of them holding the fold, so a
// click on any closes it again. tool_search has no row.
export const openRows = (fold: Fold): Line[] =>
  fold.calls.flatMap(({ call, kinds }) => {
    if (kinds[0] === "hidden") return [];
    const r = fold.results.get(call.id);
    return [callRow(call), ...(r ? [r] : [])].map((l) => ({ ...l, fold }));
  });

// The folded row's own line, which a closed fold goes back to.
export const foldRow = (fold: Fold): Line => ({ text: fold.text, color: "gray", oneLine: true, fold });

// The run not yet said, and the calls of the runs said, by id, for their results, which come after. The window holds one
// (state.ts); a resumed conversation's lines are made with one of their own (conversationLines). Each method gives the
// lines to say, in order; none says anything itself.
export class OpenRun {
  #run: { call: ToolCall; kinds: Kind[] }[] = [];
  #results = new Map<string, Line>();
  #failed: Line[] = []; // the rows of calls that failed, said where the open run ends
  #said = new Map<string, Fold>(); // the said runs' calls still waiting for their results
  // The calls of the latest reply with rows of their own, until its results come (question, `under`).
  #rowed = new Set<string>();
  #resulted = false;
  // The live row (release 8c plan, choice 67; Task 17): its two lines as the run's calls last set them, the searches and
  // shell commands started in the run, whether a search set the top line, and the latest shell call's start and end.
  #top: ((now: number) => string) | null = null;
  #under: (now: number) => string = () => "";
  #searches = 0;
  #shells = 0;
  #searchTop = false;
  #shell: { id: string; at: number; end?: number } | null = null;

  constructor(readonly options: FoldOptions) {}

  // Whether a call, as it arrives, has a row of its own.
  own(c: ToolCall): boolean {
    return kindOf(c, this.options.asked, false, this.options.shell)[0] === "own";
  }

  // A quiet call joins the run, saying nothing; any other ends it, and its own row follows the run's. An id seen again is a
  // new call, as a provider may use one again.
  call(c: ToolCall): Line[] {
    if (this.#resulted) this.#rowed.clear();
    this.#resulted = false;
    this.#said.delete(c.id);
    if (this.own(c)) {
      this.#rowed.add(c.id);
      return [...this.end(), callRow(c)];
    }
    // A new run starting says the failed rows waiting from a run said before it, as their calls ran first.
    if (!this.#run.length) this.#quiet();
    const waiting = this.#run.length ? [] : this.#failed.splice(0);
    const kinds = kindOf(c, this.options.asked, false, this.options.shell);
    this.#run.push({ call: c, kinds });
    return waiting;
  }

  // A run's call's result, kept with it for opening; one that fails, or whose call asked, turns its call its own row, said
  // where the open run ends: out of the run while it is open; still counted in its row once the run was said (choice 65,
  // a known limit), and after the result rows said meanwhile, so a later call's result stays under that call (the quality
  // review). Null for a call of its own row, whose result row describe says as before.
  result(r: ToolResult): Line[] | null {
    this.#resulted = true;
    const i = this.#run.findIndex((c) => c.call.id === r.callId);
    const fold = this.#said.get(r.callId);
    const call = i >= 0 ? this.#run[i]!.call : fold?.calls.find((c) => c.call.id === r.callId)?.call;
    if (!call) return null;
    this.#said.delete(r.callId);
    (fold?.results ?? this.#results).set(r.callId, resultRow(r));
    if (kindOf(call, this.options.asked, r.isError, this.options.shell)[0] !== "own") return [];
    if (i >= 0) {
      this.#run.splice(i, 1);
      this.#results.delete(r.callId);
    }
    this.#failed.push(callRow(call), resultRow(r));
    return [];
  }

  // A question opens, and "ends the run before its call" (choice 65): the run's calls before the asked one are said, and
  // the asked call, a quiet one, gets its own row after them; the calls after it, not yet run, stay in the run. A question
  // for no call of the lead's (a subagent's, a plain one) ends the whole run; one for a call with a row of its own says
  // nothing, as that row ended the run before it. `under`: whether the answer goes under the asked call's row, only while
  // no other call of its reply has a row of its own, whose result would come between (release 7 plan, choice 67).
  question(id: string | undefined): { lines: Line[]; under: boolean } {
    if (id === undefined) return { lines: this.end(), under: false };
    const i = this.#run.findIndex((c) => c.call.id === id);
    const fold = this.#said.get(id);
    if (i < 0 && !fold) return { lines: [], under: false };
    let lines: Line[] = [];
    let call: ToolCall;
    if (i >= 0) {
      call = this.#run[i]!.call;
      const after = this.#run.slice(i + 1);
      this.#run = this.#run.slice(0, i);
      lines = this.end();
      this.#run = after;
    } else {
      // A call of a run said already, one running beside the others (a known limit): still counted in its row.
      call = fold!.calls.find((c) => c.call.id === id)!.call;
      this.#said.delete(id);
    }
    const under = this.#rowed.size === 0;
    this.#rowed.add(id);
    return { lines: [...lines, callRow(call)], under };
  }

  // The run said, as one row, and emptied, then the rows of its calls that failed meanwhile. A run of only tool_search has
  // no row.
  end(): Line[] {
    this.#quiet();
    if (!this.#run.length) return this.#failed.splice(0);
    const fold: Fold = { text: "", calls: this.#run, results: this.#results, open: false };
    this.#run = [];
    this.#results = new Map();
    for (const c of fold.calls) if (!fold.results.has(c.call.id)) this.#said.set(c.call.id, fold);
    const text = rowText(fold.calls, this.options.server);
    if (text !== null) fold.text = text;
    return [...(text === null ? [] : [foldRow(fold)]), ...this.#failed.splice(0)];
  }

  // A run's call starting sets the live row (choice 67): the top line names the work, a search only while searches alone
  // set it, so a search after a read leaves `Reading <path>` on top; the ⎿ line is the newest call's detail, as describe's
  // brief gives it. A shell call's seconds count from `at`. tool_search sets neither; a call of no open run, nothing.
  start(id: string, at: number): void {
    const c = this.#run.findLast((x) => x.call.id === id)?.call;
    if (!c || c.name === SEARCH) return;
    const detail = brief(c.name, c.input) ?? JSON.stringify(c.input);
    const s = (n: number) => (n === 1 ? "" : "s");
    if (c.name === "find_files" || c.name === "search_files") {
      const n = ++this.#searches;
      if (this.#top === null || this.#searchTop) {
        this.#top = () => `● Searching for ${n} pattern${s(n)}`;
        this.#searchTop = true;
      }
      this.#under = () => `  ⎿  "${detail}"`;
      return;
    }
    this.#searchTop = false;
    if (c.name === "shell") {
      const n = ++this.#shells;
      const shell: { id: string; at: number; end?: number } = (this.#shell = { id, at });
      // The whole seconds since it started, until it ended, from 1 s, as the working line counts its own (WorkingLine.tsx).
      const time = (now: number) => {
        const ms = (shell.end ?? now) - shell.at;
        return ms < 1000 ? null : elapsed(ms);
      };
      this.#top = (now) => `● Running ${n} shell command${s(n)}${time(now) === null ? "" : ` · ${time(now)}`}`;
      this.#under = (now) => `  ⎿  $ ${detail}${time(now) === null ? "" : ` (${time(now)})`}`;
    } else if (isMcp(c.name)) {
      const safe = safeOf(c.name);
      this.#top = () => `● Calling ${visible(this.options.server(safe))}`;
      this.#under = () => `  ⎿  ${c.name.slice(`mcp__${safe}__`.length)}`;
    } else {
      this.#top = () => `● Reading ${detail}`;
      this.#under = () => `  ⎿  ${detail}`;
    }
  }

  // A shell call ending stops its seconds.
  finished(id: string, at: number): void {
    if (this.#shell?.id === id) this.#shell.end = at;
  }

  // The live row's two grey lines, while the run holds a call that set them; none otherwise.
  live(now: number): Line[] {
    if (!this.#run.length || this.#top === null) return [];
    return [this.#top(now), this.#under(now)].map((text) => ({ text, color: "gray", oneLine: true }));
  }

  // The live row gone, as its run ends or a new one starts.
  #quiet(): void {
    this.#top = null;
    this.#searches = this.#shells = 0;
    this.#searchTop = false;
    this.#shell = null;
  }
}

// A resumed conversation as the scrollback shows a live one, message by message (release 8a plan, Task 6; user,
// 2026-11-06: "Show it"), its runs folded as the live window folds them, the asked calls known by their saved marks
// (Task 15).
export function conversationLines(messages: Message[], opts: FoldOptions): Line[] {
  const run = new OpenRun(opts);
  return [...messages.flatMap((m) => describe(m, undefined, run)), ...run.end()];
}
