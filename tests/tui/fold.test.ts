import { describe, expect, it } from "vitest";
import type { Message, ToolCall, ToolResult } from "../../src/core/types.js";
import type { Line } from "../../src/tui/describe.js";
import { describe as lines } from "../../src/tui/describe.js";
import { conversationLines, kindOf, OpenRun, openRows, rowText, shellKinds } from "../../src/tui/fold.js";

// Release 8c plan, choice 65 and Task 15: a run of quiet tool calls is one grey row of counts, as Claude Code's is.
const call = (id: string, name: string, input: unknown): ToolCall => ({ type: "tool_call", id, name, input });
const ok = (id: string, output = "done"): ToolResult => ({ type: "tool_result", callId: id, output, isError: false });
const failed = (id: string, output: string): ToolResult => ({ type: "tool_result", callId: id, output, isError: true });
const sh = (id: string, command: string) => call(id, "shell", { command });
const read = (id: string, path = "a.txt") => call(id, "read_file", { path });
const reply = (...parts: Message["parts"]): Message => ({ role: "assistant", parts });
const results = (...parts: Message["parts"]): Message => ({ role: "user", parts });
const text = (t: string) => ({ type: "text" as const, text: t });
// The settings' names of the servers, by their safe names.
const NAMES: Record<string, string> = { plugin_mempalace_mempalace: "plugin:mempalace:mempalace" };
const opts = (asked: string[] = [], shell: "bash" | "powershell" = "bash") => ({ asked: new Set(asked), shell, server: (safe: string) => NAMES[safe] ?? safe });
const words = (calls: ToolCall[], shell: "bash" | "powershell" = "bash") =>
  rowText(calls.map((c) => ({ call: c, kinds: kindOf(c, new Set(), false, shell) })), opts().server);
const gray = (t: string) => ({ text: t, color: "gray", oneLine: true });

describe("folded tool rows", () => {
  it("says each measured row in Claude Code's words, kinds in its order, the first word capitalised", () => {
    const mempalace = call("m", "mcp__plugin_mempalace_mempalace__search", { query: "x" });
    const searches = [call("f", "find_files", { pattern: "*.ts" }), call("s", "search_files", { pattern: "x" })];
    expect(words([read("r1"), searches[0]!, read("r2"), mempalace, searches[1]!, sh("c", "cd src && git log")])).toBe(
      "Searched for 2 patterns, read 2 files, called plugin:mempalace:mempalace, ran 1 shell command",
    );
    expect(words([read("r"), sh("l", "ls"), sh("c", "cd .. && git log")])).toBe("Read 1 file, listed 1 directory, ran 1 shell command");
    expect(words([sh("a", "ls"), sh("b", "dir src")])).toBe("Listed 2 directories");
    expect(words([call("f", "find_files", { pattern: "*.ts" })])).toBe("Searched for 1 pattern");
    expect(words([sh("a", "pwd"), sh("b", "whoami")])).toBe("Ran 2 shell commands");
    // An MCP server's calls: "called <name>", with " <n> times" from 2, one part a server in the order called.
    const tv = (id: string) => call(id, "mcp__tradingview__quote_get", {});
    expect(words([tv("1"), tv("2"), tv("3"), mempalace])).toBe("Called tradingview 3 times, called plugin:mempalace:mempalace");
  });

  // tool_search is in no count and has no row (measured: Claude Code shows none).
  it("leaves tool_search out of the counts, and a run of only tool_search has no row", () => {
    const search = call("t", "tool_search", { query: "quote" });
    expect(kindOf(search, new Set(), false, "bash")).toEqual(["hidden"]);
    expect(words([search, read("r")])).toBe("Read 1 file");
    expect(words([search])).toBeNull();
  });

  it("names a server escaped, as it shows a server's name anywhere", () => {
    expect(words([call("m", "mcp__b_d__x", {})])).toBe("Called b_d"); // a server no longer set up: its safe name
    const run = new OpenRun({ ...opts(), server: () => "bad\u001b[2Jname" });
    run.call(call("m", "mcp__x__y", {}));
    expect(run.end()[0]!.text).toBe("Called bad\\u001b[2Jname");
  });

  // The shell lists, read by split in the shell the command ran in; one call is one count of its kind, however many
  // commands of that kind it holds (measured: `cat a && cat b` = Read 1 file).
  it("sorts a shell command by the lists, bash and PowerShell", () => {
    const bash = (line: string) => shellKinds(line, "bash");
    const ps = (line: string) => shellKinds(line, "powershell");
    for (const line of ["cat a", "head -n 5 a", "tail a", "wc -l a", "cat a && cat b"]) expect(bash(line)).toEqual(["read"]);
    for (const line of ["ls", "dir src"]) expect(bash(line)).toEqual(["list"]);
    for (const line of ["grep -r x .", "rg x", "find . -name '*.ts'", "fd x"]) expect(bash(line)).toEqual(["search"]);
    for (const line of ["cd src", "pwd", "echo hi", "printf x", "which node", "where node", "whoami", "date", "true"]) expect(bash(line)).toEqual(["ran"]);
    const git = ["git log", "git status", "git diff", "git show HEAD", "git rev-parse HEAD", "git branch", "git remote", "git remote -v", "git ls-files"];
    for (const line of git) expect(bash(line)).toEqual(["ran"]);
    // PowerShell's names, any letter case.
    for (const line of ["Get-Content a", "gc a", "type a", "cat a", "Get-Content a | Measure-Object", "get-content a"]) expect(ps(line)).toEqual(["read"]);
    for (const line of ["Get-ChildItem", "gci src", "ls", "dir", "GET-CHILDITEM"]) expect(ps(line)).toEqual(["list"]);
    for (const line of ["Select-String x a.txt", "sls x a.txt"]) expect(ps(line)).toEqual(["search"]);
    for (const line of ["Set-Location src", "Get-Location", "Write-Output hi", "Get-Command node", "Test-Path a", "Get-Item a", "git log"]) {
      expect(ps(line)).toEqual(["ran"]);
    }
    // Mixed kinds of the read, list and search lists: each command its own; with one of the "ran" list among them, ran.
    expect(bash("ls | wc -l")).toEqual(["list", "read"]);
    expect(bash("cd src && cat a")).toEqual(["ran"]);
    // Each list is its own shell's: bash's head and PowerShell's where are on no list of the other.
    expect(ps("head a")).toBeNull();
    expect(bash("Get-Content a")).toBeNull();
  });

  it("keeps a row of its own for a line that writes, runs a command on no list, or cannot be read", () => {
    const own = [
      "cat a > b", "cat a >> b", "cat a >| b", "cat a &> b", "cat a 2> err.txt", "cat a | tee b", "git log --output=history.txt",
      "git -c core.pager=x log", "git -C .. log", "git --git-dir=x log", "git --work-tree=x status", "git diff --ext-diff",
      "git branch new", "git remote add o x", "git push", "find . -fprint files.txt", "find . -delete", "find . -exec rm {} ;",
      "find . -execdir x ;", "find . -ok rm {} ;", "find . -okdir x ;", "find . -fprint0 x", "find . -fprintf x y", "find . -fls x",
      "fd -x rm", "fd --exec rm", "fd -X rm", "fd --exec-batch rm", "rg --pre x y", "echo $(rm a)", "cat `rm a`", "cat <(ls)",
      "rm a", "cat a; rm b", "sed -n 1p a", "less a", "more a", "tree", "cat 'unclosed",
    ];
    for (const line of own) expect([line, shellKinds(line, "bash")]).toEqual([line, null]);
    const ownPs = [
      "Get-Content a > b", "Get-Content a >> b", "gc a | Out-File b", "gc a | Set-Content b", "gc a | Add-Content b", "gc a | Tee-Object b",
      "echo $(Remove-Item a)", "& { Get-Content a }", "Remove-Item a",
    ];
    for (const line of ownPs) expect([line, shellKinds(line, "powershell")]).toEqual([line, null]);
  });

  // The user's choice, 2026-11-12 (decision C): errors thrown away or joined to the output write no file, so they fold;
  // every other redirection keeps its row, near misses among them.
  it("folds a line whose errors go to null or to the output, and keeps a row for every other redirection", () => {
    expect(shellKinds("cat a 2>/dev/null", "bash")).toEqual(["read"]);
    expect(shellKinds("grep x a 2> /dev/null", "bash")).toEqual(["search"]);
    expect(shellKinds("grep x a 2>&1", "bash")).toEqual(["search"]);
    expect(shellKinds("Get-Content a 2>$null", "powershell")).toEqual(["read"]);
    expect(shellKinds("gc a 2>&1", "powershell")).toEqual(["read"]);
    const bash = ["cat a 2>/dev/nullx", "cat a 2>/dev/null.txt", "cat a 2>/dev/null2", "cat a 1>&2", "cat a >&2", "cat a 2>&-", "cat a 2>&1x"];
    bash.push("cat a 2>/dev/null > b");
    for (const line of bash) expect([line, shellKinds(line, "bash")]).toEqual([line, null]);
    const ps = ["gc a 2>$nullx", "gc a 2>$null.txt", "gc a 2>null", "gc a *>&1", "gc a 2>$null > b", "gc a 2>/dev/null"];
    for (const line of ps) expect([line, shellKinds(line, "powershell")]).toEqual([line, null]);
  });

  // The quality review's finding 1: split leaves out a line's NAME=value words, which change what the command runs or reads
  // (LD_PRELOAD, GIT_EXTERNAL_DIFF, BASH_ENV, PATH), so a line that sets a variable keeps its row; so does PowerShell's.
  it("keeps a row for a line that sets a variable, bash and PowerShell", () => {
    const bash = ["LD_PRELOAD=./x.so cat a", "GIT_EXTERNAL_DIFF=./x git diff", "BASH_ENV=./x echo hi", "PATH=.; cat a", "PATH=."];
    bash.push("cat a && X=1 ls", "X+=1; ls");
    for (const line of bash) expect([line, shellKinds(line, "bash")]).toEqual([line, null]);
    expect(shellKinds("cat a=b", "bash")).toEqual(["read"]); // a word holding "=" is no assignment
    const ps = ["$x = 1; gc a", "$env:PATH = 'x'; gc a", "$x=1", "$x += 1; gc a", "Set-Item env:X 1; gc a", "${env:X}=1; gc a", "$a.b = 1; gc a"];
    for (const line of ps) expect([line, shellKinds(line, "powershell")]).toEqual([line, null]);
    expect(shellKinds("Select-String $x a.txt", "powershell")).toEqual(["search"]); // a variable read is no assignment
  });

  // The quality review's finding 6: `date -s` sets the clock and `printf -v` sets a variable.
  it("keeps a row for date setting the clock and printf setting a variable", () => {
    for (const line of ["date -s 2020-01-01", "date --set 2020-01-01", "date --set=2020-01-01", "date -us 2020-01-01", "printf -v PATH x", "printf -vPATH x"]) {
      expect([line, shellKinds(line, "bash")]).toEqual([line, null]);
    }
    for (const line of ["date", "date -u", "date +%s", "printf x"]) expect(shellKinds(line, "bash")).toEqual(["ran"]);
  });

  // The user's choice, 2026-11-12 (decision A): PowerShell's cd, pwd and echo are Set-Location's, Get-Location's and
  // Write-Output's names, so they are on its "ran" list too, as measured on Claude Code; git's reads stay on it (decision B).
  it("counts PowerShell's cd, pwd and echo as ran, beside git's reads", () => {
    for (const line of ["cd src; git log", "pwd", "echo hi", "CD src", "cd src; git status"]) {
      expect([line, shellKinds(line, "powershell")]).toEqual([line, ["ran"]]);
    }
  });

  it("gives a call its kind, and own to one that asked a question or failed, whatever its tool", () => {
    const kind = (c: ToolCall, asked: string[] = [], fail = false) => kindOf(c, new Set(asked), fail, "bash");
    expect(kind(read("r"))).toEqual(["read"]);
    expect(kind(call("f", "find_files", { pattern: "x" }))).toEqual(["search"]);
    expect(kind(call("s", "search_files", { pattern: "x" }))).toEqual(["search"]);
    expect(kind(call("m", "mcp__s__echo", {}))).toEqual(["called"]);
    expect(kind(sh("c", "ls"))).toEqual(["list"]);
    for (const name of ["write_file", "edit_file", "delegate", "todo"]) expect(kind(call("x", name, {}))).toEqual(["own"]);
    expect(kind(call("m", "mcp__s__echo", {}), ["m"])).toEqual(["own"]);
    expect(kind(read("r"), [], true)).toEqual(["own"]);
    expect(kind(call("t", "tool_search", {}), [], true)).toEqual(["own"]);
  });
});

describe("the open run", () => {
  it("says a run of quiet calls as one row before the text that ends it, keeping each call's row for opening", () => {
    const run = new OpenRun(opts());
    expect(lines(reply(text("Looking."), read("r1"), read("r2", "b.txt")), undefined, run)).toEqual([{ text: "Looking." }]);
    expect(lines(results(ok("r1"), ok("r2")), undefined, run)).toEqual([]);
    const said = lines(reply(text("Both say hi.")), undefined, run);
    expect(said.map(({ fold, ...l }) => l)).toEqual([gray("Read 2 files"), { text: "Both say hi." }]);
    const rows = openRows(said[0]!.fold!);
    expect(rows.every((r) => r.fold === said[0]!.fold)).toBe(true); // a click on any of them closes it
    expect(rows.map(({ fold, ...l }) => l)).toEqual([
      { text: "● read_file a.txt", color: "yellow", oneLine: true },
      { text: "  ⎿ ok", color: "gray", oneLine: true },
      { text: "● read_file b.txt", color: "yellow", oneLine: true },
      { text: "  ⎿ ok", color: "gray", oneLine: true },
    ]);
  });

  it("says the run before a call of its own row, which keeps its rows as today", () => {
    const run = new OpenRun(opts());
    const said = lines(reply(read("r"), call("w", "write_file", { path: "b.txt", content: "x" })), undefined, run);
    expect(said.map(({ fold, ...l }) => l)).toEqual([gray("Read 1 file"), { text: "● write_file b.txt", color: "yellow", oneLine: true }]);
    expect(lines(results(ok("r"), ok("w")), undefined, run)).toEqual([gray("  ⎿ ok")]);
  });

  // A failed read keeps its row: its red first line stays seen. Failing while its run is open, it leaves the run, and its
  // row is said where the run ends; failing once its run was said, where the next run ends, still counted in the row said
  // (a known limit).
  it("says a call that fails as its own red row, out of the run's count while the run is open", () => {
    const run = new OpenRun(opts());
    lines(reply(read("r1"), read("r2", "gone.txt")), undefined, run);
    expect(lines(results(ok("r1"), failed("r2", "ENOENT: no such file\nmore")), undefined, run)).toEqual([]);
    expect(run.end().map(({ fold, ...l }) => l)).toEqual([
      gray("Read 1 file"),
      { text: "● read_file gone.txt", color: "yellow", oneLine: true },
      { text: "  ⎿ ENOENT: no such file", color: "red", oneLine: true },
    ]);
    // One said already: where the run after it ends.
    lines(reply(read("r3"), read("r4", "late.txt")), undefined, run);
    expect(run.question(undefined).lines.map(({ fold, ...l }) => l)).toEqual([gray("Read 2 files")]);
    expect(lines(results(ok("r3"), failed("r4", "late")), undefined, run)).toEqual([]);
    expect(run.end()).toEqual([
      { text: "● read_file late.txt", color: "yellow", oneLine: true },
      { text: "  ⎿ late", color: "red", oneLine: true },
    ]);
  });

  // The quality review's finding 2: a call of its own row ends the run, and the run's call that then fails waits, so the
  // own call's result row stays under its own call.
  it("keeps a call's result under it when a call of the run said before it fails", () => {
    const run = new OpenRun(opts());
    const plain = (ls: Line[]) => ls.map(({ fold, ...l }) => l.text);
    const said = [
      ...lines(reply(read("r", "missing.txt"), sh("x", "rm x")), undefined, run),
      ...lines(results(failed("r", "ENOENT: no such file"), ok("x")), undefined, run),
      ...lines(reply(text("Done.")), undefined, run),
    ];
    expect(plain(said)).toEqual(["Read 1 file", "● shell rm x", "  ⎿ ok", "● read_file missing.txt", "  ⎿ ENOENT: no such file", "Done."]);
  });

  // A question ends the run before its call: the run's row, then the asked call's own row, its answer under it; the calls
  // after it, not yet run, stay in the run.
  it("ends the run at a question before the asked call, said after its row, the calls after it left open", () => {
    const run = new OpenRun(opts());
    lines(reply(read("r"), call("m", "mcp__s__echo", { text: "hi" }), read("r2", "b.txt")), undefined, run);
    const asked = run.question("m");
    expect(asked.under).toBe(true);
    expect(asked.lines.map(({ fold, ...l }) => l)).toEqual([gray("Read 1 file"), { text: '● mcp__s__echo {"text":"hi"}', color: "yellow", oneLine: true }]);
    expect(lines(results(ok("r"), ok("m"), ok("r2")), undefined, run)).toEqual([gray("  ⎿ ok")]);
    expect(run.question("m")).toEqual({ lines: [], under: false }); // its row is said
    expect(run.end().map(({ fold, ...l }) => l)).toEqual([gray("Read 1 file")]); // b.txt
    // A question for no call of the lead's ends the whole run.
    lines(reply(read("r3")), undefined, run);
    expect(run.question(undefined).lines.map(({ fold, ...l }) => l)).toEqual([gray("Read 1 file")]);
  });

  // Release 7 plan, choice 67: an answer goes under its call's row only while no other call of the reply has a row of its
  // own, whose result would come between.
  it("puts an asked call's answer under its row only while no other call of its reply has a row of its own", () => {
    const run = new OpenRun(opts());
    lines(reply(sh("a", "git status"), sh("b", "git log")), undefined, run);
    expect(run.question("a")).toMatchObject({ under: true });
    expect(run.question("b")).toMatchObject({ under: false });
    lines(results(ok("a"), ok("b")), undefined, run);
    lines(reply(call("w", "write_file", { path: "x", content: "" }), call("m", "mcp__s__echo", {})), undefined, run);
    expect(run.question("m")).toMatchObject({ under: false });
    lines(results(ok("w"), ok("m")), undefined, run);
    lines(reply(call("m2", "mcp__s__echo", {})), undefined, run); // a new reply
    expect(run.question("m2")).toMatchObject({ under: true });
  });

  // A resumed conversation folds as the live one did: an asked call, by its saved mark, keeps its own row.
  it("folds a resumed conversation, an asked MCP call keeping its row", () => {
    const history: Message[] = [
      { role: "user", parts: [text("go")] },
      reply(read("r"), call("m", "mcp__s__echo", {}), read("r2", "b.txt")),
      results(ok("r"), ok("m"), ok("r2")),
      reply(text("done")),
    ];
    const plain = (ls: Line[]) => ls.map(({ fold, ...l }) => l.text);
    expect(plain(conversationLines(history, opts(["m"])))).toEqual(["> go", "Read 1 file", "● mcp__s__echo {}", "  ⎿ ok", "Read 1 file", "done"]);
    // A transcript from before the asked mark folds it (a known limit).
    expect(plain(conversationLines(history, opts()))).toEqual(["> go", "Read 2 files, called s", "done"]);
  });
});
