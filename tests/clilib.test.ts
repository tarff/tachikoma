import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import path from "node:path";
import { privateDir } from "../src/auth/private.js";
import { Bus } from "../src/core/bus.js";
import { projectFile } from "../src/core/datadir.js";
import { readInstructions } from "../src/core/instructions.js";
import { PermissionGate, visible } from "../src/core/permissions.js";
import { listSessions, openSession, sessionsDir } from "../src/core/sessions.js";
import { Tasks } from "../src/core/tasks.js";
import type { Message, ToolSpec, Turn } from "../src/core/types.js";
import type { ExecResult, Executor } from "../src/exec/executor.js";
import { CommandLog } from "../src/exec/log.js";
import type { Hook } from "../src/hooks/config.js";
import { Hooks } from "../src/hooks/hooks.js";
import { type Answers, answersFor } from "../src/mcp/answers.js";
import type { ServerConfig } from "../src/mcp/config.js";
import { KILL_MS } from "../src/mcp/server.js";
import { Servers } from "../src/mcp/servers.js";
import {
  approvalQuestion,
  askServers,
  chooseSession,
  exitOn,
  exitSignals,
  fullPossible,
  gitBashLine,
  givenBy,
  headlessAnswer,
  headlessDeclined,
  headlessExit,
  headlessLeftOut,
  instructionsLine,
  jsonLine,
  leadOf,
  leadSession,
  mcpLines,
  networkNoted,
  newSaved,
  openSaved,
  prose,
  protectionOf,
  resolve,
  resumed,
  resumeArgs,
  screenMode,
  scrollSpeed,
  serverQuestion,
  statusSegments,
  stopSoon,
  turnAnswer,
  systemAgain,
  waitForBackground,
  WindowSessions,
} from "../src/clilib.js";
import { type Ended, Session } from "../src/core/session.js";
import { HEADLESS_LIMIT, MOST_TIMEOUT, shellTools } from "../src/tools/commands.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";
import { callTool, FakeProvider, removeTree, reply, standInRun, tempContext, usage } from "./helpers.js";

describe("the instruction files on screen", () => {
  const home = path.resolve("/home/me");
  const proj = path.resolve("/work/proj");
  const r = {
    text: "...",
    read: [
      { path: path.join(home, ".claude", "CLAUDE.md"), size: 1200 },
      { path: path.join(proj, "AGENTS.md"), size: 3100 },
    ],
    left: [{ path: path.resolve("/elsewhere/x.md"), why: "not allowed" }],
  };

  it("lists the files read, the user's folder as ~, their total size, and those left out", () => {
    expect(instructionsLine(r, home)).toBe(`Instructions: ${path.join("~", ".claude", "CLAUDE.md")}, ${path.join(proj, "AGENTS.md")} (4.3k bytes); left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
    expect(instructionsLine({ text: "", read: [], left: [] }, home)).toBeNull();
    expect(instructionsLine({ ...r, read: [] }, home)).toBe(`Instructions: none read; left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
  });

  it("asks once about the files outside the project, each with how it was reached, escaped", () => {
    const reached = [
      { path: path.resolve("/elsewhere/x.md"), how: `imported by ${path.join(proj, "CLAUDE.md")}` },
      { path: path.resolve("/elsewhere/a\u001b[2Jb.md"), how: `found as ${path.join(proj, "AGENTS.md")}` },
    ];
    expect(approvalQuestion(reached)).toBe(
      [
        "Read 2 files from outside the project, reached by the instruction files?",
        `  ${path.resolve("/elsewhere/x.md")}, imported by ${path.join(proj, "CLAUDE.md")}`,
        `  ${path.resolve("/elsewhere/a\\u001b[2Jb.md")}, found as ${path.join(proj, "AGENTS.md")}`,
        "[y/n]",
      ].join("\n"),
    );
    expect(approvalQuestion(reached.slice(0, 1))).toContain("Read 1 file from outside the project");
  });

  it("says with -p which were left out, since nobody can approve them", () => {
    expect(headlessLeftOut([{ path: path.resolve("/elsewhere/x.md"), how: "imported by CLAUDE.md" }])).toBe(
      `note: 1 instruction file from outside the project left out, since nobody can approve it in -p mode: ${path.resolve("/elsewhere/x.md")}, imported by CLAUDE.md`,
    );
  });
});

// Release 8c plan, Task 9 (choices 23, 24, 26 and 48-50; "Lines this plan adds"): a project's MCP servers asked about at
// the launch, and the launch's MCP lines. No server is started here: a Servers made without startAll starts none.
describe("MCP servers at the launch", { timeout: 15_000 }, () => {
  // An entry as the settings give it, filled in, with `asWritten` the file's own words: the entry's when not given.
  const server = (name: string, entry: ServerConfig["entry"], where: ServerConfig["where"] = "project", asWritten?: ServerConfig["asWritten"]) => ({
    name, safe: name.replace(/[^A-Za-z0-9_-]/g, "_"), entry, where, trusted: null, trustedTools: [], alwaysLoad: false, written: `as written: ${name}`,
    asWritten: asWritten ?? (entry.kind === "stdio" ? { command: entry.command, args: entry.args } : { url: entry.url, headers: entry.headers }),
  }) satisfies ServerConfig;
  const local = (name: string, args: string[] = [], where: ServerConfig["where"] = "project", env: Record<string, string> = {}) =>
    server(name, { kind: "stdio", command: "npx", args, env }, where);
  const servers = (configs: ServerConfig[], network: "on" | "off" | "none", answers: () => Answers) =>
    new Servers(configs, { root: tmpdir(), env: {}, bus: new Bus(), answers, network, lead: () => "fake:a" });
  const none = (): Answers => ({ get: () => undefined, set: () => {}, reset: () => {} });

  it("asks about a project's local server with its command and arguments, and a remote one at its address, escaped", () => {
    const tv = local("tv", ["-y", "tradingview-mcp"]);
    expect(serverQuestion(tv)).toBe('Start the MCP server "tv" from this project\'s .mcp.json: npx -y tradingview-mcp? [y/n]');
    // A command or argument that is empty or holds a space or a quote is shown in quotes, a quote in it as \", so where
    // each ends can be seen.
    expect(serverQuestion(local("a\u001b[2Jb", ["C:\\my server\\x.js", "", 'say "hi"']))).toBe(
      'Start the MCP server "a\\u001b[2Jb" from this project\'s .mcp.json: npx "C:\\my server\\x.js" "" "say \\"hi\\""? [y/n]',
    );
    const remote = server("sanity", { kind: "http", url: "https://mcp.sanity.io/\u202e", headers: {} });
    expect(serverQuestion(remote)).toBe('Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.sanity.io/\\u202e? [y/n]');
  });

  // Choice 48: as .mcp.json writes it, so a key filled in from the environment never reaches the screen.
  it("shows the entry as written, ${VAR} unfilled, never the value filled in", () => {
    const filled = { kind: "stdio" as const, command: "npx", args: ["--key=sk-secret-123"], env: {} };
    const tv = server("tv", filled, "project", { command: "npx", args: ["--key=${TOKEN}"] });
    expect(serverQuestion(tv)).toBe('Start the MCP server "tv" from this project\'s .mcp.json: npx --key=${TOKEN}? [y/n]');
    const url = { kind: "http" as const, url: "https://mcp.example.com/mcp?key=sk-secret-123", headers: {} };
    const sanity = server("sanity", url, "project", { url: "https://mcp.example.com/mcp?key=${TOKEN}", headers: {} });
    expect(serverQuestion(sanity)).toBe(
      'Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.example.com/mcp?key=${TOKEN} (sends TOKEN)? [y/n]',
    );
    for (const c of [tv, sanity]) expect(serverQuestion(c)).not.toContain("sk-secret-123");
  });

  // Choice 49: the variables a local entry sets, names only, in the file's order, escaped and quoted as the command is; a
  // remote server's headers are not named, only the variables they read (choice 64, below).
  it("names the variables a local server's entry sets, never their values, and no headers", () => {
    const env = { NODE_OPTIONS: "--require ./steal.js", "MY KEY\u001b": "sk-secret-123" };
    expect(serverQuestion(local("tv", ["server.js"], "project", env))).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json: npx server.js (sets NODE_OPTIONS, "MY KEY\\u001b")? [y/n]',
    );
    const headers = { kind: "http" as const, url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-secret-123" } };
    expect(serverQuestion(server("sanity", headers))).toBe(
      'Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.example.com/mcp? [y/n]',
    );
  });

  // Choice 64: the variables a remote entry's address and headers read, as written, names only, in the file's order, each
  // once, escaped and quoted as a local one's are; one that reads none names nothing.
  it("names the variables a remote server's address and headers read, never their values", () => {
    const filled = { kind: "http" as const, url: "https://tools.example.dev/mcp", headers: { Authorization: "Bearer sk-secret-123" } };
    const one = server("tools", filled, "project", { url: "https://tools.example.dev/mcp", headers: { Authorization: "Bearer ${TICKETS_TOKEN}" } });
    expect(serverQuestion(one)).toBe('Connect to the MCP server "tools" from this project\'s .mcp.json at https://tools.example.dev/mcp (sends TICKETS_TOKEN)? [y/n]');
    const headers = { Authorization: "Bearer ${TICKETS_TOKEN}", "X-Team": "${TEAM}", "X-Key": "${MY KEY\u001b:-none}" };
    const several = server("tools", filled, "project", { url: "https://${HOST:-tools.example.dev}/mcp?team=${TEAM}", headers });
    expect(serverQuestion(several)).toBe(
      'Connect to the MCP server "tools" from this project\'s .mcp.json at https://${HOST:-tools.example.dev}/mcp?team=${TEAM} ' +
        '(sends HOST, TEAM, TICKETS_TOKEN, "MY KEY\\u001b")? [y/n]',
    );
    const none = server("tools", filled, "project", { url: "https://tools.example.dev/mcp", headers: { "X-Team": "core" } });
    expect(serverQuestion(none)).toBe('Connect to the MCP server "tools" from this project\'s .mcp.json at https://tools.example.dev/mcp? [y/n]');
    for (const c of [one, several, none]) expect(serverQuestion(c)).not.toContain("sk-secret-123");
  });

  it("asks about each project server not yet answered for its entry, in order, and keeps a yes and a no for the next launch", async () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-mcp-"));
    onTestFinished(() => removeTree(top));
    const data = path.join(top, "data", "tachikoma");
    answersFor(top, data).set("old", "as written: old", true);
    const asked: string[] = [];
    const replies = [true, false];
    const configs = [local("mine", [], "user"), local("old"), local("yes"), local("no")];
    const failed: string[] = [];
    await askServers(configs, () => answersFor(top, data), async (question) => (asked.push(question), replies.shift()!), (line) => failed.push(line));
    expect(asked).toEqual([serverQuestion(local("yes")), serverQuestion(local("no"))]);
    expect(failed).toEqual([]);
    const kept = answersFor(top, data);
    expect(["old", "yes", "no"].map((name) => kept.get(name, `as written: ${name}`))).toEqual([true, true, false]);
    // Nothing read nor asked without a project server.
    const never = async () => expect.unreachable();
    await askServers([local("mine", [], "user")], () => expect.unreachable("no project server, so no answers are read"), never, never);
  });

  // Choice 50: an answer that cannot be written holds for this launch, with one red line each, and the launch goes on. The
  // data folder cannot be written as a file stands where the answers' folder goes, which the test made itself; no
  // permission is changed.
  it("says an answer that could not be saved, and keeps it for this launch", async () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-mcp-"));
    onTestFinished(() => removeTree(top));
    const data = path.join(top, "data", "tachikoma");
    let answers: Answers | undefined;
    const blocked = () => {
      answers = answersFor(top, data); // read first: nothing is there yet
      mkdirSync(data, { recursive: true });
      writeFileSync(path.dirname(projectFile("mcp-answers", top, data)), "a file where the answers' folder goes");
      return answers;
    };
    const failed: string[] = [];
    const replies = [true, false];
    await askServers([local("yes"), local("no\u001b")], blocked, async () => replies.shift()!, (line) => failed.push(line));
    const unsaved = (name: string) => new RegExp(`^Your answer for ${name} could not be saved \\(.+\\); Tachikoma asks again at the next launch\\.$`);
    expect(failed).toEqual([expect.stringMatching(unsaved("yes")), expect.stringMatching(unsaved("no\\\\u001b"))]);
    expect([answers!.get("yes", "as written: yes"), answers!.get("no\u001b", "as written: no\u001b")]).toEqual([true, false]);
  });

  // In -p every project server without a yes, one answered no included (the plan's line, Task 9's spec review).
  it("says once that the sandbox's network keeps every server off, and in -p names each project server without a yes", () => {
    const configs = [local("mine", [], "user"), local("yes"), local("no"), local("new")];
    expect(mcpLines(servers(configs, "off", none), { print: true })).toEqual([
      "MCP servers are off: the sandbox's network is off, and servers run outside the box until a later release. Start with --network on to use them.",
    ]);
    const given = (): Answers => ({ get: (name) => ({ yes: true, no: false })[name], set: () => {}, reset: () => {} });
    expect(mcpLines(servers(configs, "none", given), { print: true })).toEqual([
      "MCP server no from .mcp.json was skipped: -p starts only the project's servers you said yes to in the window.",
      "MCP server new from .mcp.json was skipped: -p starts only the project's servers you said yes to in the window.",
    ]);
    expect(mcpLines(servers(configs, "none", given), { print: false })).toEqual([]);
    expect(mcpLines(servers([], "off", none), { print: true })).toEqual([]);
  });
});

// The line a -p run prints for each action it declines, naming the subagent that asked, if one did (found at the
// combined review: its space after the colon was lost).
describe("headlessDeclined", () => {
  const why =
    "declined, nobody to ask in -p mode (--mode project allows ordinary writes inside the project, " +
    "but protected files, shell commands and anything outside it are still refused)";
  it("says why, then the action, after a space, its subagent's name escaped before it", () => {
    expect(headlessDeclined("run: ls")).toBe(`${why}: run: ls`);
    expect(headlessDeclined("run: ls", "t2 (a\u001b[2Jb)")).toBe(`${why}: t2 (a\\u001b[2Jb): run: ls`);
  });

  // Release 7 plan, Task 8: a dangerous command's red lines, escaped by the gate as the action is, each on its own line
  // before the declined one. The gate is the one -p mode makes; the command is text it reads, never run.
  it("says each danger first, a line each, escaped as the gate escapes them", async () => {
    const line = "git push --force origin a\u001b[8m; git reset --hard HEAD~3";
    let printed = "";
    const ask = async (summary: string, _detail?: string, owner?: { name: string }, _plain?: boolean, warnings?: string[]) => {
      printed = headlessDeclined(summary, owner?.name, warnings);
      return false;
    };
    const gate = new PermissionGate("project", ask, "x", { headless: true });
    await expect(gate.require({ kind: "shell", outside: false, summary: `run: ${line}`, command: line })).rejects.toThrow("Not allowed: this command matches");
    expect(printed).toBe(
      [
        "Danger: rewriting or deleting git history: git push --force origin a\\u001b[8m",
        "Danger: rewriting or deleting git history: git reset --hard HEAD~3",
        `${why}: run: git push --force origin a\\u001b[8m; git reset --hard HEAD~3`,
      ].join("\n"),
    );
  });
});

// Release 7 plan, Task 8 (choices 57 and 59): what the launch hands the gate from git's settings, for the file tools.
describe("protectionOf", () => {
  it("protects the hooks folders and the git folders as folders, and the settings files as files", () => {
    const git = {
      files: ["/p/.git/config", "/home/me/.gitconfig"],
      hooksPaths: ["/p/githooks"],
      gitDirs: ["/p/.bare"],
      problems: [{ file: "/p/x", why: "it is a link" }],
      lineEndings: {},
    };
    expect(protectionOf(git)).toEqual({ hooks: ["/p/githooks", "/p/.bare"], files: ["/p/.git/config", "/home/me/.gitconfig"] });
  });

  it("is empty without git, so only the fixed list protects (choice 11)", () => {
    expect(protectionOf(undefined)).toEqual({ hooks: [], files: [] });
  });
});

describe("headlessExit", () => {
  const run = { aborted: false, failed: false, declined: false };

  it("is 0 when the run finished cleanly", () => {
    expect(headlessExit(run)).toBe(0);
  });

  it("is 1 when a turn failed", () => {
    expect(headlessExit({ ...run, failed: true })).toBe(1);
  });

  it("is 1 when an action was declined, so a script does not take it for success", () => {
    expect(headlessExit({ ...run, declined: true })).toBe(1);
  });

  it("is 128 + SIGINT when stopped, whatever else happened", () => {
    expect(headlessExit({ aborted: true, failed: true, declined: true })).toBe(128 + constants.signals.SIGINT);
  });
});

// Background commands plan, Task 11 (design, "With -p", "How the wait ends"; choices 8, 21, 22, 25 and 29): after -p's
// first answer the run waits while background commands run, takes a turn for each ending, and stops what is left however
// the wait ends. The lead is a FakeProvider and the commands a stand-in executor's runs, which the test ends.
describe("waitForBackground", () => {
  const started = (id: string, command: string): Turn => callTool(id, "shell", { command, background: true });
  const both = (a: string, b: string): Turn => ({ parts: [...started("c1", a).parts, ...started("c2", b).parts], usage });
  const ok = (stdout: string): ExecResult => ({ code: 0, signal: null, stdout, stderr: "" });
  const limits = { started: HEADLESS_LIMIT, moved: HEADLESS_LIMIT, most: MOST_TIMEOUT };

  async function setup(turns: (Turn | Error)[], more: { limits?: boolean; stopWhen?: (root: string) => string } = {}) {
    const ctx = await tempContext();
    onTestFinished(() => removeTree(ctx.root));
    const runs: { command: string; log: CommandLog; end: (r: ExecResult) => void; stopped: boolean }[] = [];
    const executor: Executor = {
      exec: () => Promise.reject(new Error("exec is not used here")),
      start: (command) => {
        let end!: (r: ExecResult) => void;
        const run = standInRun(new Promise((resolve) => (end = resolve)));
        const entry = { command, log: run.log, end, stopped: false };
        runs.push(entry);
        return { ...run, stop: () => ((entry.stopped = true), run.stop()) };
      },
    };
    const bus = new Bus();
    // As the CLI's -p marks a run failed: any error but a tool's or a hook's (cli.tsx).
    let failed = false;
    bus.on("error", (e) => void (e.kind !== "tool" && e.kind !== "hook" && (failed = true)));
    // A Stop hook that stops the turn once its flag file exists, so a test chooses the turn it stops.
    const hooks: { hooks?: Hooks } = {};
    if (more.stopWhen) {
      const script = path.join(ctx.root, "stop.cjs");
      const stop = JSON.stringify({ continue: false, stopReason: "enough" });
      writeFileSync(script, `process.stdout.write(require("fs").existsSync(process.argv[2]) ? ${JSON.stringify(stop)} : "");`);
      const args = [script, more.stopWhen(ctx.root)];
      const hook: Hook = { event: "Stop", matcher: { all: true }, command: process.execPath, args, async: false, where: '"Stop"' };
      const where = { sessionId: () => "s1", transcript: () => undefined, root: ctx.root, mode: () => "never" as const, effort: () => undefined };
      hooks.hooks = new Hooks({ hooks: [hook], off: false, leftOut: [] }, { ...where, lead: () => "fake:lead" }, bus);
    }
    const lead = new FakeProvider("lead", turns);
    const tasks = new Tasks({
      bus, max: 8, worker: () => new FakeProvider("w", []), system: "sub", tools: [], ctx: { ...ctx, executor }, ...(more.limits ? { limits } : {}),
    });
    onTestFinished(() => tasks.close());
    const tools = shellTools(tasks, { shell: "PowerShell", headless: true });
    const session = new Session({ lead, tools, system: "s", ctx: { ...ctx, executor }, bus, inbox: () => tasks.take(), tasks, ...hooks });
    const answers: string[] = [];
    const answer = (before: Message | undefined) => {
      const text = turnAnswer(before, session.messages);
      if (text !== undefined) answers.push(text);
    };
    // The first turn, as the CLI sends it and prints its answer.
    const first = async (signal: AbortSignal) => {
      const before = session.messages.at(-1);
      const ended = await session.send("go", signal);
      answer(before);
      return ended;
    };
    const wait = (ended: Ended | void, signal: AbortSignal, waitingLine?: (line: string) => void) =>
      waitForBackground(ended, session, tasks, signal, { bus, failed: () => failed, answer, ...(waitingLine ? { waitingLine } : {}) });
    const exit = (signal: AbortSignal, ended: unknown) => headlessExit({ aborted: signal.aborted, failed: failed || ended !== undefined, declined: false });
    const sent = (n: number) => JSON.stringify(lead.seen[n]!.at(-1));
    return { ctx, runs, tasks, lead, bus, answers, first, wait, exit, sent };
  }

  it("takes a turn when a background command ends, prints its answer, and then returns", async () => {
    const s = await setup([started("c1", "node build.js"), reply("Started it."), reply("It printed done.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    expect(first).toBeUndefined();
    const waited = s.wait(first, stop.signal);
    s.runs[0]!.log.add("done\n");
    s.runs[0]!.end(ok("done\n"));
    expect(await waited).toBeUndefined();
    expect(s.answers).toEqual(["Started it.", "It printed done."]);
    expect(s.lead.seen).toHaveLength(3);
    expect(s.sent(2)).toContain("Background command t1 (node build.js) ended with exit code 0:\\ndone");
    expect(s.exit(stop.signal, undefined)).toBe(0);
  });

  it("takes a turn for each of two endings", async () => {
    const s = await setup([both("node a.js", "node b.js"), reply("Started both."), reply("a ended."), reply("b ended.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    const waited = s.wait(first, stop.signal);
    s.runs[0]!.end(ok(""));
    await vi.waitFor(() => expect(s.answers).toHaveLength(2));
    s.runs[1]!.end(ok(""));
    expect(await waited).toBeUndefined();
    expect(s.answers).toEqual(["Started both.", "a ended.", "b ended."]);
    expect(s.sent(2)).toContain("Background command t1 (node a.js) ended with exit code 0, with no new output.");
    expect(s.sent(3)).toContain("Background command t2 (node b.js) ended with exit code 0, with no new output.");
  });

  // User choice 37, PR #18 review: two endings waiting at once still get a turn each, in the order they ended.
  it("takes a turn for each of two endings that came before the wait could take either", async () => {
    const s = await setup([both("node a.js", "node b.js"), reply("Started both."), reply("a ended."), reply("b ended.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    s.runs[0]!.end(ok(""));
    s.runs[1]!.end(ok(""));
    await Promise.all(s.tasks.all.map((t) => t.done));
    expect(await s.wait(first, stop.signal)).toBeUndefined();
    expect(s.answers).toEqual(["Started both.", "a ended.", "b ended."]);
    expect(s.lead.seen).toHaveLength(4);
    expect(s.sent(2)).toContain("Background command t1 (node a.js) ended with exit code 0, with no new output.");
    expect(s.sent(2)).not.toContain("Background command t2");
    expect(s.sent(3)).toContain("Background command t2 (node b.js) ended with exit code 0, with no new output.");
  });

  it("stops at Ctrl-C during the wait: the command stopped unrecorded, no turn, exit 130, no timer or listener left", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const s = await setup([started("c1", "npm run dev"), reply("Started it.")], { limits: true });
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    const lines: string[] = [];
    const listening = [s.bus.listenerCount("tasks"), getEventListeners(stop.signal, "abort").length];
    const waited = s.wait(first, stop.signal, (line) => lines.push(line));
    await vi.advanceTimersByTimeAsync(1_000);
    stop.abort();
    expect(await waited).toBeUndefined();
    expect(s.runs[0]!.stopped).toBe(true);
    expect(s.tasks.get("t1")!.state).toBe("stopped");
    expect(s.tasks.take()).toEqual([]); // closed, not stopped: no note for a turn that never comes (choice 29)
    expect(s.lead.seen).toHaveLength(2);
    expect(s.exit(stop.signal, undefined)).toBe(128 + constants.signals.SIGINT);
    expect(vi.getTimerCount()).toBe(0); // the -p limit's timer and the waiting line's
    expect([s.bus.listenerCount("tasks"), getEventListeners(stop.signal, "abort").length]).toEqual(listening);
    expect(lines).toEqual([]);
  });

  it("stops at a Stop hook's continue: false on the first turn: returns its result at once, the command stopped, exit 1", async () => {
    const s = await setup([started("c1", "npm run dev"), reply("Started it.")], { stopWhen: () => process.execPath }); // a file that exists: every turn stops
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    expect(first).toEqual({ stopped: "enough" });
    const ended = await s.wait(first, stop.signal);
    expect(ended).toBe(first);
    expect(s.runs[0]!.stopped).toBe(true);
    expect(s.lead.seen).toHaveLength(2);
    expect(s.exit(stop.signal, ended)).toBe(1);
  });

  it("stops at a Stop hook's continue: false on a later turn, returning that turn's result, the other command stopped", async () => {
    const s = await setup([both("node a.js", "npm run dev"), reply("Started both."), reply("a ended.")], { stopWhen: (root) => path.join(root, "stop-now") });
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    expect(first).toBeUndefined();
    const waited = s.wait(first, stop.signal);
    writeFileSync(path.join(s.ctx.root, "stop-now"), "");
    s.runs[0]!.end(ok(""));
    const ended = await waited;
    expect(ended).toEqual({ stopped: "enough" });
    expect(s.answers).toEqual(["Started both.", "a ended."]);
    expect(s.runs[1]!.stopped).toBe(true);
    expect(s.lead.seen).toHaveLength(3);
    expect(s.exit(stop.signal, ended)).toBe(1);
  });

  it("stops at a failed model call on the first turn: the command stopped, no turn, exit 1", async () => {
    const s = await setup([started("c1", "npm run dev"), new Error("the model is down")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    expect(first).toBeUndefined();
    expect(await s.wait(first, stop.signal)).toBeUndefined();
    expect(s.runs[0]!.stopped).toBe(true);
    expect(s.lead.seen).toHaveLength(2);
    expect(s.exit(stop.signal, undefined)).toBe(1);
  });

  it("stops at a failed model call on a later turn: the other command stopped, no more turns, exit 1", async () => {
    const s = await setup([both("node a.js", "npm run dev"), reply("Started both."), new Error("the model is down")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    const waited = s.wait(first, stop.signal);
    s.runs[0]!.end(ok(""));
    expect(await waited).toBeUndefined();
    expect(s.runs[1]!.stopped).toBe(true);
    expect(s.lead.seen).toHaveLength(3);
    expect(s.exit(stop.signal, undefined)).toBe(1);
  });

  it("takes a turn when the -p time limit stops a command, which is no failure", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const s = await setup([started("c1", "npm run dev"), reply("Started it."), reply("It was stopped.")], { limits: true });
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    const waited = s.wait(first, stop.signal);
    await vi.advanceTimersByTimeAsync(HEADLESS_LIMIT);
    expect(await waited).toBeUndefined();
    expect(s.runs[0]!.stopped).toBe(true);
    expect(s.answers).toEqual(["Started it.", "It was stopped."]);
    expect(s.sent(2)).toContain('Background command \\"npm run dev\\" was stopped after reaching its background time limit');
    expect(s.exit(stop.signal, undefined)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says the waiting line once, after 5 s, naming each running command, escaped", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const odd = "node a.js\u001b[2J";
    const s = await setup([both(odd, "npm run dev"), reply("Started both."), reply("a ended."), reply("b ended.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    const lines: string[] = [];
    const waited = s.wait(first, stop.signal, (line) => lines.push(line));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(lines).toEqual([`Waiting for background work to finish: t1 (${visible(odd)}), t2 (npm run dev)`]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lines).toHaveLength(1);
    s.runs[0]!.end(ok(""));
    s.runs[1]!.end(ok(""));
    expect(await waited).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // A turn's message carrying t1's ending, as the session pushes it, before the model is asked.
  const carriesT1 = (m: Message) => m.role === "user" && JSON.stringify(m).includes("Background command t1");

  it("gives a command that ends during a later turn a turn of its own after it", async () => {
    const s = await setup([both("node a.js", "node b.js"), reply("Started both."), reply("a ended."), reply("b ended.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    s.bus.on("message", (m) => void (carriesT1(m) && s.runs[1]!.end(ok(""))));
    const waited = s.wait(first, stop.signal);
    s.runs[0]!.end(ok(""));
    expect(await waited).toBeUndefined();
    expect(s.answers).toEqual(["Started both.", "a ended.", "b ended."]);
    expect(s.lead.seen).toHaveLength(4);
    expect(s.sent(2)).not.toContain("Background command t2");
    expect(s.sent(3)).toContain("Background command t2 (node b.js) ended with exit code 0, with no new output.");
  });

  it("stops at Ctrl-C during a later turn: the other command stopped, no further turn, exit 130", async () => {
    const s = await setup([both("node a.js", "npm run dev"), reply("Started both."), reply("a ended."), reply("never asked")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    s.bus.on("message", (m) => void (carriesT1(m) && stop.abort()));
    const waited = s.wait(first, stop.signal);
    s.runs[0]!.end(ok(""));
    expect(await waited).toBeUndefined();
    expect(s.runs[1]!.stopped).toBe(true);
    expect(s.lead.seen).toHaveLength(3); // the stopped turn's own request, and none after it
    expect(s.answers).not.toContain("never asked");
    expect(s.exit(stop.signal, undefined)).toBe(128 + constants.signals.SIGINT);
  });
});

describe("headless output", () => {
  it("shows escape codes and bidi overrides in an answer as text, keeping line breaks and tabs", () => {
    expect(prose("a\u001b]52;c;eA==\u0007\nb\tc\u202e")).toBe("a\\u001b]52;c;eA==\\u0007\nb\tc\\u202e");
  });

  it("escapes what JSON leaves raw, and the line still parses to the same value", () => {
    const data = { text: "x\u009b8m\u202e\u007f\n" };
    const line = jsonLine("message", data);
    expect(line).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
    expect(JSON.parse(line)).toEqual({ event: "message", data });
  });
});

describe("headlessAnswer", () => {
  const piped = { raw: false, tty: false };

  it("leaves ordinary text exactly as written: Windows line endings, tabs and plain direction marks", () => {
    const text = "line one\r\nline two\tתודה\u200f عربي\u061c ok\u200e\n";
    expect(headlessAnswer(text, piped)).toEqual({ out: text });
  });

  it("escapes control codes, a lone carriage return and text-order overrides, and says so when piped", () => {
    expect(headlessAnswer("a\u001b[8mb\rc\u202ed\u2066e", piped)).toEqual({
      out: "a\\u001b[8mb␍c\\u202ed\\u2066e",
      note: "note: 4 control characters in the answer were printed as escapes; --raw prints the answer exactly",
    });
  });

  it("gives no note on a terminal, where the escapes are in plain sight", () => {
    expect(headlessAnswer("a\u001bb", { raw: false, tty: true })).toEqual({ out: "a\\u001bb" });
  });

  it("prints the answer exactly with --raw", () => {
    expect(headlessAnswer("a\u001b]52;c;eA==\u0007", { raw: true, tty: false })).toEqual({ out: "a\u001b]52;c;eA==\u0007" });
  });
});

describe("statusSegments", () => {
  it("shows every segment when none are given", () => {
    expect(statusSegments(undefined)).toEqual(SEGMENTS);
  });

  it("keeps the first of repeated segments", () => {
    expect(statusSegments("cost, lead,cost,lead")).toEqual(["cost", "lead"]);
  });

  it("names --status when a segment is unknown", () => {
    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")');
  });
});

describe("screenMode", () => {
  it("starts in full screen unless --classic is given or TACHI_CLASSIC is set to anything but empty or 0", () => {
    expect(screenMode(undefined, {}, true)).toBe("full");
    expect(screenMode(true, {}, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "1" }, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "yes" }, true)).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "0" }, true)).toBe("full");
    expect(screenMode(undefined, { TACHI_CLASSIC: "" }, true)).toBe("full");
    expect(screenMode(true, { TACHI_CLASSIC: "0" }, true)).toBe("classic");
  });

  it("is classic when the output is not a terminal, or in CI, where Ink draws no live frames", () => {
    expect(screenMode(undefined, {}, false)).toBe("classic");
    for (const env of [{ CI: "true" }, { CI: "1" }, { CI: "" }, { CONTINUOUS_INTEGRATION: "yes" }]) expect(screenMode(undefined, env, true)).toBe("classic");
    for (const env of [{ CI: "0" }, { CI: "false" }, { CONTINUOUS_INTEGRATION: "false" }]) expect(screenMode(undefined, env, true)).toBe("full");
  });

  // Release 6 design, "Which wins": --classic, then TACHI_CLASSIC, then the settings file's "screen". Neither the flag nor
  // the variable can ask for full screen, so the file's "full" holds only where neither asks for classic.
  it("takes the settings file's screen after --classic and TACHI_CLASSIC", () => {
    expect(screenMode(undefined, {}, true, "classic")).toBe("classic");
    expect(screenMode(undefined, {}, true, "full")).toBe("full");
    expect(screenMode(true, {}, true, "full")).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "1" }, true, "full")).toBe("classic");
    expect(screenMode(undefined, { TACHI_CLASSIC: "0" }, true, "classic")).toBe("classic"); // 0 is unset, so the file's applies
    expect(screenMode(undefined, {}, false, "full")).toBe("classic");
  });
});

describe("fullPossible", () => {
  // Found at the final review: /screen asks it, whatever --classic or TACHI_CLASSIC chose at the start.
  it("is false where the output is not a terminal, or in CI, as screenMode reads them, and true otherwise", () => {
    expect(fullPossible({}, true)).toBe(true);
    expect(fullPossible({ TACHI_CLASSIC: "1" }, true)).toBe(true);
    expect(fullPossible({}, false)).toBe(false);
    expect(fullPossible({ CI: "true" }, true)).toBe(false);
    expect(fullPossible({ CI: "0" }, true)).toBe(true);
  });
});

// Release 8b plan, choices 1 and 2: the launch's line when a hook run by a shell is in force and Git Bash is not found.
// The lookup is a stand-in: Git for Windows' install folder cannot be hidden from a launch on a PC that has it.
describe("gitBashLine", () => {
  const LINE = "Git Bash was not found, so hooks run by a shell use Windows PowerShell; set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe to change that.";
  const hook = (more: Partial<Hook> = {}): Hook => ({ event: "Stop", matcher: { all: true }, command: "check.sh", async: false, where: '"Stop"', ...more });
  const none = () => null;
  it("names Git Bash's absence on Windows when a hook run by a shell is in force", () => {
    expect(gitBashLine({ hooks: [hook({ args: ["x"] }), hook()] }, "win32", none)).toBe(LINE);
    expect(gitBashLine({ hooks: [hook({ shell: "bash" })] }, "win32", none)).toBe(LINE); // it asked for bash, and gets PowerShell
  });

  it("says nothing with Git Bash found, elsewhere than Windows, with hooks off, or for hooks that need no shell or ask for PowerShell", () => {
    expect(gitBashLine({ hooks: [hook()] }, "win32", () => "C:\\Git\\bin\\bash.exe")).toBeUndefined();
    expect(gitBashLine({ hooks: [hook()] }, "linux", none)).toBeUndefined();
    expect(gitBashLine({ hooks: [hook()], disableAllHooks: true }, "win32", none)).toBeUndefined();
    expect(gitBashLine({ hooks: [hook({ args: ["x"] }), hook({ shell: "powershell" })] }, "win32", none)).toBeUndefined();
    expect(gitBashLine({}, "win32", none)).toBeUndefined();
    // Release 8c plan, Task 8: an mcp_tool hook calls a server, with no shell.
    expect(gitBashLine({ hooks: [hook({ command: "", mcp: { server: "s", tool: "t", input: {} } })] }, "win32", none)).toBeUndefined();
  });
});

describe("scrollSpeed", () => {
  it("is 3 rows a notch unless given", () => {
    expect(scrollSpeed(undefined, {})).toBe(3);
  });

  it("takes digits with an optional decimal point, above 0 and up to 20", () => {
    expect(scrollSpeed("0.5", {})).toBe(0.5);
    expect(scrollSpeed(".5", {})).toBe(0.5);
    expect(scrollSpeed("20", {})).toBe(20);
    expect(scrollSpeed(undefined, { TACHI_SCROLL_SPEED: "1.5" })).toBe(1.5);
  });

  it("refuses anything else, naming where it came from", () => {
    for (const bad of ["0", "21", "-1", "1e1", "abc", " 3", "", "3.", "20.5"]) {
      expect(() => scrollSpeed(bad, {})).toThrow(`--scroll-speed must be a number above 0, up to 20 (got "${bad}")`);
      if (bad === "") continue; // an empty variable is unset (below)
      expect(() => scrollSpeed(undefined, { TACHI_SCROLL_SPEED: bad })).toThrow(`TACHI_SCROLL_SPEED must be a number above 0, up to 20 (got "${bad}")`);
    }
  });

  it("takes the option over the variable, and an empty variable as unset", () => {
    expect(scrollSpeed("2", { TACHI_SCROLL_SPEED: "abc" })).toBe(2);
    expect(scrollSpeed(undefined, { TACHI_SCROLL_SPEED: "" })).toBe(3);
  });
});

describe("exitSignals", () => {
  it("ends on Ctrl+Break on Windows and on SIGQUIT elsewhere, besides SIGTERM and SIGHUP", () => {
    expect(exitSignals("win32")).toEqual(["SIGTERM", "SIGHUP", "SIGBREAK"]);
    expect(exitSignals("linux")).toEqual(["SIGTERM", "SIGHUP", "SIGQUIT"]);
    expect(exitSignals("darwin")).toEqual(["SIGTERM", "SIGHUP", "SIGQUIT"]);
  });
});

// Final review: Ctrl-C in the terminal while the editor ran ended the whole session. As Git's launch_editor does, Ctrl-C
// and Ctrl-\ are ignored while a program has the terminal; every other signal still ends Tachikoma (choice 31).
describe("exitOn", () => {
  it("exits on each signal with 128 and its number, but on SIGINT and SIGQUIT only while no program runs", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    onTestFinished(() => exit.mockRestore());
    for (const sig of ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      exitOn(sig, () => false)();
      expect(exit).toHaveBeenLastCalledWith(128 + constants.signals[sig]);
    }
    exit.mockClear();
    exitOn("SIGINT", () => true)();
    exitOn("SIGQUIT", () => true)();
    expect(exit).not.toHaveBeenCalled();
    for (const sig of ["SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
      exitOn(sig, () => true)();
      expect(exit).toHaveBeenLastCalledWith(128 + constants.signals[sig]);
    }
  });

  // Release 8c plan, Task 9's spec review: a signal stops the MCP servers before the exit, which comes however the stop
  // ends; one ignored while a program has the terminal stops nothing.
  it("exits once `before` has settled, ended or failed, and runs none for a signal it ignores", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as typeof process.exit);
    onTestFinished(() => exit.mockRestore());
    let end!: () => void;
    exitOn("SIGTERM", () => false, () => new Promise<void>((resolve) => (end = resolve)))();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exit).not.toHaveBeenCalled();
    end();
    await vi.waitFor(() => expect(exit).toHaveBeenLastCalledWith(128 + constants.signals.SIGTERM));
    exitOn("SIGHUP", () => false, () => Promise.reject(new Error("made-up failure")))();
    await vi.waitFor(() => expect(exit).toHaveBeenLastCalledWith(128 + constants.signals.SIGHUP));
    exit.mockClear();
    const before = vi.fn(async () => {});
    exitOn("SIGINT", () => true, before)();
    expect(before).not.toHaveBeenCalled();
  });
});

// Choice 3's wait bounds a signal's stop of the MCP servers, so a hung one cannot hold the exit (Task 9's spec review).
describe("stopSoon", () => {
  it("ends when the servers have stopped, or after choice 3's wait for one that never does", async () => {
    let stopped = false;
    await stopSoon({ stopAll: async () => void (stopped = true) });
    expect(stopped).toBe(true);
    const at = performance.now();
    await stopSoon({ stopAll: () => new Promise<void>(() => {}) });
    // Less 1 ms: the timer runs on the event loop's whole-millisecond clock, which can round its start down.
    expect(performance.now() - at).toBeGreaterThanOrEqual(KILL_MS - 1);
  });
});

// Release 8c plan, Task 9's review: a -p run prints only the reply its turn added, so a resumed one stopped before it sent
// anything does not print the saved session's last answer.
describe("turnAnswer", () => {
  const user = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const model = (...texts: string[]): Message => ({ role: "assistant", parts: texts.map((text) => ({ type: "text" as const, text })) });
  it("gives the reply the turn added, its text parts joined by line breaks, and none when the turn added none", () => {
    const saved = [user("hi"), model("the saved answer")];
    expect(turnAnswer(saved.at(-1), saved)).toBeUndefined();
    expect(turnAnswer(saved.at(-1), [...saved, user("again")])).toBeUndefined();
    expect(turnAnswer(saved.at(-1), [...saved, user("again"), model("a", "b")])).toBe("a\nb");
    expect(turnAnswer(undefined, [user("hi"), model("new")])).toBe("new");
  });
});

describe("endOnEpipe", () => {
  it("ends quietly when the reader of its output stops early", async () => {
    // A real pipe: a single large write fails with EPIPE once the reader has gone.
    const script = `import { endOnEpipe } from "./src/clilib.ts"; process.stdout.on("error", endOnEpipe); process.stdout.write("x\\n".repeat(1e6));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});

// Release 6 design, "Which wins": a flag, then a TACHI_ variable, then the settings file, then the default.
describe("resolve", () => {
  it("takes the lead from --lead, then TACHI_LEAD, then the file, an empty variable being unset", () => {
    expect(leadOf({ lead: "a:1" }, { TACHI_LEAD: "a:2" }, { lead: "a:3" })).toBe("a:1");
    expect(leadOf({}, { TACHI_LEAD: "a:2" }, { lead: "a:3" })).toBe("a:2");
    expect(leadOf({}, { TACHI_LEAD: "" }, { lead: "a:3" })).toBe("a:3");
    expect(leadOf({}, {}, {})).toBeUndefined();
  });

  it("takes the worker from --worker, then TACHI_WORKER, then the file", () => {
    expect(resolve({ worker: "w:1" }, { TACHI_WORKER: "w:2" }, { worker: "w:3" }).worker).toBe("w:1");
    expect(resolve({}, { TACHI_WORKER: "w:2" }, { worker: "w:3" }).worker).toBe("w:2");
    expect(resolve({}, { TACHI_WORKER: "" }, { worker: "w:3" }).worker).toBe("w:3");
    expect(resolve({}, {}, {}).worker).toBeUndefined();
  });

  it("takes mode, effort and fallback from the flag, then the file, then the default", () => {
    expect(resolve({ mode: "project" }, {}, { mode: "never" }).mode).toBe("project");
    expect(resolve({}, {}, { mode: "never" }).mode).toBe("never");
    expect(resolve({}, {}, {}).mode).toBe("ask");
    expect(resolve({ effort: "low" }, {}, { effort: "max" }).effort).toBe("low");
    expect(resolve({}, {}, { effort: "max" }).effort).toBe("max");
    expect(resolve({}, {}, {}).effort).toBeUndefined();
    expect(resolve({ fallback: "f:1" }, {}, { fallback: "f:2" }).fallback).toBe("f:1");
    expect(resolve({ fallback: "" }, {}, { fallback: "f:2" }).fallback).toBe(""); // an empty --fallback turns the file's off
    expect(resolve({}, {}, { fallback: "f:2" }).fallback).toBe("f:2");
    expect(resolve({}, {}, {}).fallback).toBeUndefined();
  });

  // Release 7 design, "Launching" and "The modes": the sandbox and its network are off unless asked for, and the judge is
  // unset, the lead's model then judging (release 7 plan, Task 7). An empty --judge still wins, as --worker's does.
  it("takes the sandbox, the network and the judge from the flag, then the file, then the default", () => {
    expect(resolve({ sandbox: "live" }, {}, { sandbox: "copy" }).sandbox).toBe("live");
    expect(resolve({}, {}, { sandbox: "copy" }).sandbox).toBe("copy");
    expect(resolve({}, {}, {}).sandbox).toBe("off");
    expect(resolve({ network: "off" }, {}, { network: "on" }).network).toBe("off");
    expect(resolve({}, {}, { network: "on" }).network).toBe("on");
    expect(resolve({}, {}, {}).network).toBe("off");
    expect(resolve({ judge: "j:1" }, {}, { judge: "j:2" }).judge).toBe("j:1");
    expect(resolve({ judge: "" }, {}, { judge: "j:2" }).judge).toBe("");
    expect(resolve({}, {}, { judge: "j:2" }).judge).toBe("j:2");
    expect(resolve({}, {}, {}).judge).toBeUndefined();
  });

  it("takes auto mode from the flag or the file", () => {
    expect(resolve({ mode: "auto" }, {}, { mode: "ask" }).mode).toBe("auto");
    expect(resolve({}, {}, { mode: "auto" }).mode).toBe("auto");
  });

  it("takes max tasks and the status parts from the flag, then the file, then the default", () => {
    expect(resolve({ "max-tasks": "4" }, {}, { maxTasks: 6 }).maxTasks).toBe(4);
    expect(resolve({}, {}, { maxTasks: 6 }).maxTasks).toBe(6);
    expect(resolve({}, {}, {}).maxTasks).toBe(8);
    expect(resolve({ status: "cost" }, {}, { status: ["lead"] }).segments).toEqual(["cost"]);
    expect(resolve({}, {}, { status: ["lead"] }).segments).toEqual(["lead"]);
    expect(resolve({}, {}, {}).segments).toEqual(SEGMENTS);
  });

  it("takes the scroll speed from --scroll-speed, then TACHI_SCROLL_SPEED, then the file, then 3", () => {
    expect(resolve({ "scroll-speed": "2" }, { TACHI_SCROLL_SPEED: "4" }, { scrollSpeed: 5 }).speed).toBe(2);
    expect(resolve({}, { TACHI_SCROLL_SPEED: "4" }, { scrollSpeed: 5 }).speed).toBe(4);
    expect(resolve({}, { TACHI_SCROLL_SPEED: "" }, { scrollSpeed: 5 }).speed).toBe(5);
    expect(resolve({}, {}, {}).speed).toBe(3);
  });

  // Release 5's rule: -p has no screen to scroll, so it ignores TACHI_SCROLL_SPEED, and so the file's scrollSpeed too.
  it("with -p, ignores TACHI_SCROLL_SPEED and the file's scrollSpeed, but not --scroll-speed", () => {
    expect(resolve({ print: "hi" }, { TACHI_SCROLL_SPEED: "abc" }, { scrollSpeed: 5 }).speed).toBe(3);
    expect(resolve({ print: "hi", "scroll-speed": "2" }, {}, { scrollSpeed: 5 }).speed).toBe(2);
  });

  it("still checks a flag given over the file, in the flag's words", () => {
    expect(() => resolve({ mode: "x" }, {}, { mode: "ask" })).toThrow('--mode must be one of: ask, project, auto, never (got "x")');
    // `never` is offered and read, as copy mode is built (release 7 plan, Task 21); the launch says it needs copy mode.
    expect(resolve({ mode: "never" }, {}, {}).mode).toBe("never");
    expect(() => resolve({ sandbox: "x" }, {}, { sandbox: "off" })).toThrow('--sandbox must be one of: off, live, copy (got "x")');
    expect(() => resolve({ network: "x" }, {}, { network: "off" })).toThrow('--network must be one of: off, on (got "x")');
    expect(() => resolve({ effort: "x" }, {}, {})).toThrow('--effort must be one of: low, medium, high, xhigh, max (got "x")');
    expect(() => resolve({ "max-tasks": "1e1" }, {}, { maxTasks: 2 })).toThrow('--max-tasks must be a whole number from 1 (got "1e1")');
    expect(() => resolve({ status: "nope" }, {}, { status: ["lead"] })).toThrow(
      '--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tasks, tools (got "nope")',
    );
    expect(() => resolve({ "scroll-speed": "21" }, {}, { scrollSpeed: 2 })).toThrow('--scroll-speed must be a number above 0, up to 20 (got "21")');
  });
});

// Release 6 design, "Live edits": an entry a flag or variable gave at launch stays as given, and the line names which.
describe("givenBy", () => {
  it("names the flag that gave each entry, or else its variable, an empty variable being unset", () => {
    const flags = {
      lead: "a:1",
      mode: "ask",
      effort: "low",
      fallback: "",
      worker: "w:1",
      "max-tasks": "2",
      status: "lead",
      classic: true,
      "scroll-speed": "2",
      sandbox: "off",
      network: "on",
      judge: "j:1",
    };
    const env = { TACHI_LEAD: "a:2", TACHI_WORKER: "w:2", TACHI_CLASSIC: "1", TACHI_SCROLL_SPEED: "4" };
    expect(givenBy(flags, env)).toEqual({
      lead: "--lead",
      mode: "--mode",
      effort: "--effort",
      fallback: "--fallback", // an empty --fallback still wins over the file
      worker: "--worker",
      maxTasks: "--max-tasks",
      status: "--status",
      screen: "--classic",
      scrollSpeed: "--scroll-speed",
      sandbox: "--sandbox",
      network: "--network",
      judge: "--judge",
    });
    expect(givenBy({}, env)).toEqual({ lead: "TACHI_LEAD", worker: "TACHI_WORKER", screen: "TACHI_CLASSIC", scrollSpeed: "TACHI_SCROLL_SPEED" });
    expect(givenBy({}, { TACHI_LEAD: "", TACHI_WORKER: "", TACHI_CLASSIC: "0", TACHI_SCROLL_SPEED: "" })).toEqual({});
    expect(givenBy({}, {})).toEqual({});
  });
});

// Release 8a plan, Task 6 and choice 11: parseArgs cannot take an optional value, so a -r or --resume with none, last or
// before another option, is given an empty one, which means "show the list".
describe("resumeArgs", () => {
  it("gives -r and --resume an empty value when none follows, and leaves a given one alone", () => {
    expect(resumeArgs(["-r"])).toEqual(["-r", ""]);
    expect(resumeArgs(["--resume", "-p", "hi"])).toEqual(["--resume", "", "-p", "hi"]);
    expect(resumeArgs(["-r", "abc", "-c"])).toEqual(["-r", "abc", "-c"]);
    expect(resumeArgs(["--resume=abc", "-r", "my name"])).toEqual(["--resume=abc", "-r", "my name"]);
  });
});

// Release 8a plan, Task 6 (choices 4, 8, 9 and 11-13). One sessions folder for the cases that open or start a session,
// made private once, as privateDir starts PowerShell on Windows, each case's sessions with ids of their own; plain
// folders, never made private, for choosing, which only reads.
describe("saved sessions at launch", { timeout: 15_000 }, () => {
  let top: string;
  let dir: string;
  let plain = 0;
  beforeAll(() => {
    top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-"));
    dir = sessionsDir(top, path.join(top, "data", "tachikoma"));
    privateDir(dir);
  });
  afterAll(() => removeTree(top));
  const folder = () => {
    const d = path.join(top, "plain", `p${++plain}`);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const at = "2026-11-06T00:00:00.000Z";
  const tools: ToolSpec[] = [{ name: "echo", description: "Says it back.", inputSchema: { type: "object" } }];
  const start = (id: string, o: { print?: boolean; tools?: ToolSpec[] } = {}) => ({
    t: "start",
    at,
    v: 1,
    id,
    project: top,
    lead: "fake:a",
    version: "0.8.0",
    print: o.print ?? false,
    system: "Saved prompt.",
    tools: o.tools ?? tools,
  });
  // This launch's system prompt when it is the one the sessions were saved under: the same sandbox setting.
  const SAVED = { box: false, full: "Saved prompt." };
  const prompt = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
  const said = (text: string, native?: Message["native"]): Message => ({ role: "assistant", parts: [{ type: "text", text }], ...(native ? { native } : {}) });
  const message = (m: Message) => ({ t: "message", at, message: m });
  // A session's file as a Transcript writes it, its lines as given, last changed `ago` days before now.
  const saved = (d: string, id: string, lines: object[], ago = 0) => {
    const file = path.join(d, `${id}.jsonl`);
    writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    const when = new Date(Date.now() - ago * 24 * 60 * 60 * 1000);
    utimesSync(file, when, when);
    return file;
  };
  const talk = (id: string, words: string, o: { print?: boolean; name?: string } = {}) => [
    start(id, o),
    message(prompt(words)),
    message(said("Done.")),
    ...(o.name ? [{ t: "name", at, name: o.name }] : []),
  ];
  const read = (file: string) => readFileSync(file, "utf8");

  describe("chooseSession", () => {
    const NONE = { fail: "No saved session to continue in this folder." };
    const NEEDS = { fail: "tachi --resume needs a terminal to list sessions; give it a session's id or name." };

    it("continues the newest session, and with -p the newest -p session", () => {
      const d = folder();
      expect(chooseSession(d, { continue: true, print: false, terminal: true })).toEqual(NONE);
      saved(d, "older", talk("older", "one"), 3);
      saved(d, "newer", talk("newer", "two"), 2);
      saved(d, "printed", talk("printed", "three", { print: true }), 1);
      expect(chooseSession(d, { continue: true, print: false, terminal: true })).toEqual({ id: "newer" });
      expect(chooseSession(d, { continue: true, print: true, terminal: false })).toEqual({ id: "printed" });
      const other = folder();
      saved(other, "only", talk("only", "one"));
      expect(chooseSession(other, { continue: true, print: true, terminal: false })).toEqual(NONE);
    });

    it("opens a session by id or name, lists the sessions a name belongs to, and names what it cannot find", () => {
      const d = folder();
      saved(d, "s1", talk("s1", "one", { name: "fix" }), 3);
      saved(d, "s2", talk("s2", "two", { name: "twin" }), 2);
      saved(d, "s3", talk("s3", "three", { name: "twin" }), 1);
      saved(d, "p1", talk("p1", "four", { print: true }));
      expect(chooseSession(d, { resume: "s2", print: false, terminal: true })).toEqual({ id: "s2" });
      expect(chooseSession(d, { resume: "fix", print: true, terminal: false })).toEqual({ id: "s1" });
      expect(chooseSession(d, { resume: "p1", print: false, terminal: true })).toEqual({ id: "p1" }); // an id finds a -p run too
      expect(chooseSession(d, { resume: "twin", print: false, terminal: true })).toMatchObject({ list: [{ id: "s3" }, { id: "s2" }], name: "twin" });
      const missing = "No session named or numbered nope in this folder; tachi --resume lists them.";
      expect(chooseSession(d, { resume: "nope", print: false, terminal: true })).toEqual({ fail: missing });
      // A file the list leaves out, as it cannot be read, is opened by its id, so the launch can say why.
      writeFileSync(path.join(d, "broken.jsonl"), "not a start line\n");
      expect(chooseSession(d, { resume: "broken", print: false, terminal: true })).toEqual({ id: "broken" });
      // A link of that name is not one: a junction, to a folder of the test's own.
      mkdirSync(path.join(d, "elsewhere"));
      symlinkSync(path.join(d, "elsewhere"), path.join(d, "linked.jsonl"), "junction");
      expect(chooseSession(d, { resume: "linked", print: false, terminal: true })).toEqual({ fail: missing.replace("nope", "linked") });
    });

    it("lists the sessions but -p runs for -r alone, which needs a terminal, as a name more than one session has does, saying how many", () => {
      const d = folder();
      expect(chooseSession(d, { resume: "", print: false, terminal: false })).toEqual(NEEDS);
      expect(chooseSession(d, { resume: "", print: false, terminal: true })).toEqual({ fail: "No saved sessions in this folder." });
      saved(d, "s1", talk("s1", "one", { name: "twin" }), 2);
      saved(d, "s2", talk("s2", "two", { name: "twin" }), 1);
      saved(d, "p1", talk("p1", "three", { print: true }));
      const list = chooseSession(d, { resume: "", print: false, terminal: true });
      expect(list).toMatchObject({ list: [{ id: "s2" }, { id: "s1" }] });
      expect((list as { list: unknown[] }).list).toHaveLength(2);
      expect(chooseSession(d, { resume: "", print: true, terminal: false })).toEqual(NEEDS);
      const shared = "2 sessions are named twin; give one's id instead (tachi --resume lists them in a terminal).";
      expect(chooseSession(d, { resume: "twin", print: true, terminal: false })).toEqual({ fail: shared });
    });
  });

  describe("openSaved and resumed", () => {
    const native = { provider: "anthropic", content: [{ type: "thinking", thinking: "hm", signature: "x" }] };
    const other: ToolSpec[] = [{ name: "write_file", description: "Writes a file.", inputSchema: { type: "object" } }];
    // Opened, and made this window's under `as` tools, lead `lead` and system prompt `prompt`, in the window unless
    // `interactive` says not; let go once the case ends, as the process's exit would.
    type As = { fork?: boolean; as?: ToolSpec[]; lead?: string; prompt?: { box: boolean; full: string }; interactive?: boolean };
    const open = (id: string, o: As = {}) => {
      const s = openSaved(dir, id, { fork: o.fork ?? false });
      if ("problem" in s) throw new Error(s.problem);
      const r = resumed(s, { tools: o.as ?? tools, lead: o.lead ?? "fake:a", prompt: o.prompt ?? SAVED, interactive: o.interactive ?? true });
      onTestFinished(r.release);
      return r;
    };
    const lines = (file: string) => read(file).trim().split("\n").map((l) => JSON.parse(l));

    it("opens a session under its lock, mends a torn last line, and says what it skipped", () => {
      const file = saved(dir, "torn", [...talk("torn", "first words"), { t: "message", at, message: "not a message" }]);
      appendFileSync(file, '{"t":"message","at":"2026-11-06T00:00:00.000Z","mess');
      const o = open("torn");
      expect(read(path.join(dir, "torn.lock"))).toBe(String(process.pid));
      expect(read(file).endsWith('"mess\n')).toBe(true);
      expect(o.conversation).toMatchObject({ id: "torn", system: "Saved prompt.", messages: [prompt("first words"), said("Done.")], prompts: ["first words"] });
      expect(o.conversation).toMatchObject({ nextPicture: 1, nextTask: 1 });
      expect(o.lines.map((l) => l.text)).toEqual(["Resumed: first words.", "2 damaged lines of this session were skipped."]);
      expect(o.lost).toEqual([]);
      o.conversation.transcript!.write({ t: "message", message: prompt("next") });
      expect(read(file).split("\n").at(-2)).toContain('"next"');
      o.release();
      expect(readdirSync(dir)).not.toContain("torn.lock");
    });

    it("names a session by its first prompt's first line, as one screen line", () => {
      saved(dir, "multi", talk("multi", "the first line\nand the second"));
      expect(open("multi").lines[0]).toEqual({ text: "Resumed: the first line.", oneLine: true });
    });

    it("names a session with neither name nor prompt by its id", () => {
      saved(dir, "bare", [start("bare"), { t: "shortened", at, system: "Short.", message: said("A summary.") }]);
      expect(open("bare").lines.map((l) => l.text)).toEqual(["Resumed: bare."]);
    });

    it("opens a copy of a session open in another window, saying so, and of any session with --fork-session, the originals unchanged", () => {
      saved(dir, "held", talk("held", "one", { name: "held one" }));
      saved(dir, "forked", talk("forked", "two"));
      const before = [read(path.join(dir, "held.jsonl")), read(path.join(dir, "forked.jsonl"))];
      const lock = openSession(dir, "held");
      onTestFinished(() => lock?.release());
      const copy = open("held");
      const fork = open("forked", { fork: true });
      expect(copy.conversation.id).not.toBe("held");
      expect(fork.conversation.id).not.toBe("forked");
      expect(copy.lines.map((l) => l.text)).toEqual(["Opened a copy: that session is open in another window.", "Resumed: held one."]);
      expect(fork.lines.map((l) => l.text)).toEqual(["Resumed: two."]);
      for (const o of [copy, fork]) {
        expect(read(path.join(dir, `${o.conversation.id}.lock`))).toBe(String(process.pid));
        expect(o.conversation.messages).toHaveLength(2);
        o.conversation.transcript!.write({ t: "message", message: prompt("more") });
      }
      expect([read(path.join(dir, "held.jsonl")), read(path.join(dir, "forked.jsonl"))]).toEqual(before);
    });

    // Release 8a plan, choice 4 (Task 6 spec review): the lead a resume brings is recorded. Its tools are not: the session's
    // first request writes its tools line, holding tool_search and the MCP tools too (release 8c plan, Task 9; choice 46).
    it("writes a lead line for another lead, and no tools line for other tools, and nothing for the same ones", () => {
      const file = saved(dir, "same", talk("same", "hi"));
      open("same").release();
      expect(lines(file).map((l) => l.t)).toEqual(["start", "message", "message"]);
      open("same", { lead: "fake:b", as: other }).release();
      expect(lines(file).slice(3)).toEqual([expect.objectContaining({ t: "lead", lead: "fake:b" })]);
    });

    // Release 8c plan, Task 9 (choice 46): the history comes under the tools it was last saved under, which the session's
    // first request compares with its own (keepThinking), so the strip is left to it; the line is said only when
    // Tachikoma's own tools changed.
    it("keeps a reply's thinking for the session under the tools it was saved under, saying when Tachikoma's own changed", () => {
      saved(dir, "thought", [start("thought"), message(prompt("hi")), message(said("Done.", native))]);
      saved(dir, "plain", [start("plain"), message(prompt("hi")), message(said("Done."))]);
      const changed = "The tools have changed since this session was saved, so its earlier replies are sent without their thinking.";
      // Under other tools of Tachikoma's own: the line, the thinking kept for the session's first request to leave out.
      const b = open("thought", { as: other });
      expect(b.conversation.messages).toEqual([prompt("hi"), said("Done.", native)]);
      expect(b.conversation.tools).toEqual(tools);
      expect(b.lines.map((l) => l.text)).toEqual(["Resumed: hi.", changed]);
      // As the session's first request under them writes it, then its reply.
      b.conversation.transcript!.write({ t: "tools", tools: other });
      b.conversation.transcript!.write({ t: "message", message: prompt("again") });
      b.conversation.transcript!.write({ t: "message", message: said("Done again.", native) });
      b.release();
      // Back under the first tools: the reply before the tools changed goes without its thinking here, as thinking is left
      // out only from the front (Task 6b's quality review); the later one's is left for the session.
      const a = open("thought");
      expect(a.conversation.messages).toEqual([prompt("hi"), said("Done."), prompt("again"), said("Done again.", native)]);
      expect(a.conversation.tools).toEqual(other);
      expect(a.lines.map((l) => l.text)).toEqual(["Resumed: hi.", changed]);
      expect(open("plain", { as: other }).lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
    });

    // Choice 46 at resume: a saved set holding tool_search and MCP tools beside Tachikoma's own says nothing and keeps the
    // thinking, as the session's first request offers the same set when the same servers are ready.
    it("says nothing of tool_search and the MCP tools in the saved set, keeping the thinking and that set", () => {
      const mcp: ToolSpec[] = [
        { name: "tool_search", description: "Finds MCP tools.", inputSchema: { type: "object" } },
        { name: "mcp__tv__quote_get", description: "A quote.", inputSchema: { type: "object" } },
      ];
      const searched = [start("searched"), { t: "tools", at, tools: [...tools, ...mcp] }, message(prompt("hi")), message(said("Done.", native))];
      const file = saved(dir, "searched", searched);
      const o = open("searched");
      expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
      expect(o.conversation.messages).toEqual([prompt("hi"), said("Done.", native)]);
      expect(o.conversation.tools).toEqual([...tools, ...mcp]);
      o.release();
      expect(lines(file).map((l) => l.t)).toEqual(["start", "tools", "message", "message"]);
    });

    // Release 8a final review (user, 2026-11-07: "Rebuild it", "Save the setting", "Only at the change"): a session saved
    // under another sandbox setting gets this launch's prompt from then on, saved so with the setting, a reply keeping its
    // thinking only under the prompt it was made under. The setting is compared, never the prompt's text.
    it("gives a session saved under another sandbox setting this launch's system prompt, saving it, and says so once", () => {
      const file = saved(dir, "boxed", [start("boxed"), message(prompt("hi")), message(said("Done.", native))]);
      saved(dir, "unthought", [start("unthought"), message(prompt("hi")), message(said("Done."))]);
      const box = { box: true, full: "Box prompt.\n\nRules, read again." };
      const changed = "The sandbox setting has changed since this session was saved, so the model is told this launch's shell and project folder";
      const b = open("boxed", { prompt: box, as: other }); // the box's shell tool is another
      expect(b.conversation.system).toBe(box.full);
      expect(b.conversation.messages).toEqual([prompt("hi"), said("Done.")]);
      expect(b.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${changed}, and its earlier replies are sent without their thinking.`]);
      expect(lines(file).at(-1)).toMatchObject({ t: "system", system: box.full, box: true });
      // As the session's first request under the box's tools writes them (choice 46), then its reply.
      b.conversation.transcript!.write({ t: "tools", tools: other });
      b.conversation.transcript!.write({ t: "message", message: prompt("again") });
      b.conversation.transcript!.write({ t: "message", message: said("Done again.", native) });
      b.release();
      // In the box again, its prompt worded otherwise, the folder typed in other letters for one: nothing more is written
      // or said, the tools line neither, and only the first reply goes without its thinking.
      const again = open("boxed", { prompt: { box: true, full: "Box prompt for C:\\OTHER\\CASE." }, as: other });
      expect(again.conversation.system).toBe(box.full);
      expect(again.conversation.messages).toEqual([prompt("hi"), said("Done."), prompt("again"), said("Done again.", native)]);
      expect(again.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
      again.release();
      expect(lines(file).filter((l) => l.t === "system")).toHaveLength(1);
      // The same setting as saved, its prompt worded otherwise, keeps the saved prompt; a reply without thinking loses none.
      const same = open("unthought", { prompt: { box: false, full: "Other words." } });
      expect(same.conversation.system).toBe("Saved prompt.");
      same.release();
      const plain = open("unthought", { prompt: box });
      expect(plain.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${changed}.`]);
      expect(plain.conversation.system).toBe(box.full);
    });

    // Release 8a final review (user, 2026-11-07: "Becomes normal"): a -p run opened in the window leaves no mark when
    // opened with -p again, and becomes a session as any other in the window, marked once.
    it("makes a -p run opened in the window a session as any other, in -c and the list", () => {
      const d = folder();
      const file = saved(d, "p1", talk("p1", "one", { print: true }));
      const s = openSaved(d, "p1", { fork: false });
      if ("problem" in s) throw new Error(s.problem);
      resumed(s, { tools, lead: "fake:a", prompt: SAVED, interactive: false }).release();
      expect(listSessions(d, { print: false })).toEqual([]);
      for (const _ of [1, 2]) {
        const w = openSaved(d, "p1", { fork: false });
        if ("problem" in w) throw new Error(w.problem);
        resumed(w, { tools, lead: "fake:a", prompt: SAVED, interactive: true }).release();
      }
      expect(lines(file).filter((l) => l.t === "interactive")).toHaveLength(1);
      expect(listSessions(d, { print: false })).toMatchObject([{ id: "p1", print: false }]);
      expect(chooseSession(d, { continue: true, print: false, terminal: true })).toEqual({ id: "p1" });
    });

    it("tells the model once of each subagent that had not finished, and gives a crash's unanswered call its result", () => {
      const call: Message = { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "delegate", input: { task: "look" } }] };
      const subagent = { t: "subagent", at, id: "t1", description: "look around", file: "t1.jsonl" };
      saved(dir, "crashed", [start("crashed"), message(prompt("go")), message(call), subagent]);
      const o = open("crashed");
      expect(o.lost).toEqual(["Subagent t1 (look around) had not finished when the session ended; its answer was lost."]);
      const result = { type: "tool_result", callId: "c1", output: expect.stringMatching(/^Outcome unknown: /), isError: true };
      expect(o.conversation.messages.at(-1)!.parts[0]).toMatchObject(result);
      expect(o.conversation.nextTask).toBe(2);
      // Not told yet: a resume left before the next request reports it again.
      o.release();
      const again = open("crashed");
      expect(again.lost).toHaveLength(1);
      again.reported();
      expect(lines(path.join(dir, "crashed", "subagents", "t1.jsonl"))).toMatchObject([{ t: "ended", state: "lost" }]);
      again.release();
      expect(open("crashed").lost).toEqual([]);
    });

    // A subagent's id from the file names its file only when it is one Tasks gives, t and a number.
    it("writes the lost line into no file outside the subagents folder", () => {
      const subagent = { t: "subagent", at, id: "../planted", description: "not one", file: "x.jsonl" };
      saved(dir, "strange", [start("strange"), message(prompt("go")), message(said("Done.")), subagent]);
      const o = open("strange");
      o.reported();
      expect(readdirSync(dir)).not.toContain("strange");
      expect(readdirSync(dir).filter((n) => n.startsWith("planted"))).toEqual([]);
    });

    // Background commands plan, choice 15 (design, "Resume"): a command that had not ended is reported once, as an
    // unfinished subagent is, its `command-ended` line written into the session's own transcript once it has been told.
    describe("a background command that had not ended", () => {
      const command = (id: string, text: string) => ({ t: "command", at, id, command: text });
      const notEnded = (id: string, text: string) => `Command ${id} (${text}) had not ended when the session ended; it is not running in this session.`;
      const endings = (file: string) => lines(file).filter((l) => l.t === "command-ended");

      it("is told the model once, cut as a first line cuts a command, and one that ended is not", () => {
        const long = "x".repeat(1_200);
        const file = saved(dir, "running", [
          ...talk("running", "go"),
          command("t1", "npm test"),
          { t: "command-ended", at, id: "t1", state: "done" },
          command("t2", "npm run dev"),
          command("t3", long),
        ]);
        const o = open("running");
        expect(o.lost).toEqual([notEnded("t2", "npm run dev"), notEnded("t3", `${"x".repeat(1_000)}… [+200 chars]`)]);
        expect(o.conversation.nextTask).toBe(4);
        // Not told yet: a resume left before the next request reports them again.
        o.release();
        const again = open("running");
        expect(again.lost).toHaveLength(2);
        again.reported();
        expect(endings(file)).toMatchObject([{ id: "t1", state: "done" }, { id: "t2", state: "lost" }, { id: "t3", state: "lost" }]);
        again.release();
        expect(open("running").lost).toEqual([]);
      });

      // A command's id names no file, only a line in the session's own transcript, so even one Tasks never gives is marked.
      it("marks a command whose id Tasks never gives, so it too is told only once", () => {
        const file = saved(dir, "oddid", [...talk("oddid", "go"), command("odd", "npm run dev")]);
        const o = open("oddid");
        expect(o.lost).toEqual([notEnded("odd", "npm run dev")]);
        o.reported();
        expect(endings(file)).toMatchObject([{ id: "odd", state: "lost" }]);
        o.release();
        expect(open("oddid").lost).toEqual([]);
      });

      // --fork-session's copy holds the command line, so it is told there once; the original keeps its own to tell.
      it("is told once in a --fork-session copy, which marks it there and not in the original", () => {
        const original = saved(dir, "forkcmd", [...talk("forkcmd", "go"), command("t1", "npm run dev")]);
        const fork = open("forkcmd", { fork: true });
        expect(fork.lost).toEqual([notEnded("t1", "npm run dev")]);
        fork.reported();
        expect(endings(fork.conversation.transcript!.file)).toMatchObject([{ id: "t1", state: "lost" }]);
        fork.release();
        expect(open(fork.conversation.id).lost).toEqual([]);
        expect(endings(original)).toEqual([]);
        expect(open("forkcmd").lost).toEqual([notEnded("t1", "npm run dev")]);
      });

      // /branch's copy, as WindowSessions hands its lost lines out.
      it("is told once in /branch's copy, which marks it there and not in the original", () => {
        const original = saved(dir, "branchcmd", [...talk("branchcmd", "go"), command("t1", "npm run dev")]);
        const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, SAVED);
        onTestFinished(() => w.release());
        const next = w.branch("branchcmd", "fake:a", "a branch");
        if ("problem" in next) throw new Error(next.problem);
        w.switched(next);
        expect(w.lost()).toEqual([notEnded("t1", "npm run dev")]);
        expect(w.lost()).toEqual([]);
        expect(endings(next.conversation.transcript!.file)).toMatchObject([{ id: "t1", state: "lost" }]);
        expect(endings(original)).toEqual([]);
      });

      // Design, "Resume": an old "Started t2" in the history never names new work, so stop_task t2 finds no task t2.
      it("leaves its id to no new command, so stop_task answers that there is no such task", async () => {
        const input = { command: "npm run dev", background: true };
        const call: Message = { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell", input }] };
        const result: Message = { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "Started t2 in the background.", isError: false }] };
        const subagent = { t: "subagent", at, id: "t1", description: "look around", file: "t1.jsonl" };
        const history = [message(prompt("go")), subagent, message(call), command("t2", "npm run dev"), message(result), message(said("Done."))];
        saved(dir, "started", [start("started"), ...history]);
        const o = open("started");
        const ctx = await tempContext();
        onTestFinished(() => removeTree(ctx.root));
        const executor: Executor = {
          exec: () => Promise.reject(new Error("exec is not used here")),
          start: () => standInRun(new Promise(() => {})),
        };
        const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => new FakeProvider("w", []), system: "sub", tools: [], ctx: { ...ctx, executor } });
        onTestFinished(() => void tasks.stop());
        tasks.from(o.conversation.nextTask); // as Session.load does
        const shell = shellTools(tasks, { shell: "PowerShell", headless: false });
        const use = (name: string, input: unknown) => shell.find((t) => t.spec.name === name)!.run(input, { ...ctx, executor });
        expect(await use("shell", { command: "npm run dev", background: true })).toBe("Started t3 in the background.");
        expect(await use("stop_task", { id: "t2" })).toBe("No task t2.");
      });
    });

    it("refuses a session it cannot read, in the approved line, leaving no lock or copy behind, a copy it made removed", () => {
      const names = () => readdirSync(dir).sort();
      for (const [id, text, why] of [
        ["broken", "not a start line\n", "its first line is missing or damaged"],
        ["odd", '{"t":"odd"}\n', "its first line is missing or damaged"],
      ] as const) {
        const file = path.join(dir, `${id}.jsonl`);
        writeFileSync(file, text);
        const problem = `${file} could not be read as a session (${why}).`;
        const before = names();
        expect(openSaved(dir, id, { fork: false })).toEqual({ problem });
        expect(openSaved(dir, id, { fork: true })).toEqual({ problem }); // "odd" is copied, then read, then removed
        expect(names()).toEqual(before);
      }
    });

    it("takes the copy's lock before writing it, a copy whose lock is held being no copy", () => {
      const file = saved(dir, "lockfirst", talk("lockfirst", "hi"));
      const held = openSession(dir, "lockfirst-copy");
      onTestFinished(() => held?.release());
      const problem = `${file} could not be copied (its lock could not be taken).`;
      expect(openSaved(dir, "lockfirst", { fork: true, copy: "lockfirst-copy" })).toEqual({ problem });
      expect(readdirSync(dir)).not.toContain("lockfirst-copy.jsonl");
    });

    // The failure is a file standing where the copy's folder goes, under the copy's id the test gives.
    it("says a copy it cannot make could not be copied, leaving none of it behind", () => {
      const file = saved(dir, "pics", talk("pics", "hi"));
      mkdirSync(path.join(dir, "pics", "pictures"), { recursive: true });
      writeFileSync(path.join(dir, "pics-copy"), "in the copy's folder's place");
      const got = openSaved(dir, "pics", { fork: true, copy: "pics-copy" });
      expect(got).toEqual({ problem: expect.stringMatching(/ could not be copied \(EEXIST: .+\)\.$/) });
      expect((got as { problem: string }).problem.startsWith(`${file} could not be copied (`)).toBe(true);
      expect(names()).not.toContain("pics-copy.jsonl");
      expect(read(path.join(dir, "pics-copy"))).toBe("in the copy's folder's place"); // not the copy's own, so kept
      expect(names()).not.toContain("pics-copy.lock");
      function names() {
        return readdirSync(dir);
      }
    });
  });

  // Release 8a plan, choice 3 (user, 2026-11-06: "Re-read, reuse launch's answer"): a shortening's prompt reads the
  // instruction files again, a file outside the project going in only as the launch's question answered for it.
  it("reads the instruction files again, outside ones only as the launch's question answered for them", async () => {
    const own = mkdtempSync(path.join(tmpdir(), "tachi-clilib-instr-"));
    onTestFinished(() => removeTree(own));
    const [home, root, outside] = [path.join(own, "home"), path.join(own, "project"), path.join(own, "outside")];
    for (const d of [home, root, outside]) mkdirSync(d);
    writeFileSync(path.join(outside, "allowed.md"), "allowed words");
    writeFileSync(path.join(outside, "new.md"), "new words");
    writeFileSync(path.join(root, "CLAUDE.md"), "first words\n@../outside/allowed.md\n");
    const where = { root, home, top: root };
    const asked = new Map<string, boolean>();
    const launch = await readInstructions(where, async (reached) => {
      for (const r of reached) asked.set(r.path, true);
      return true;
    });
    expect(launch.text).toContain("allowed words");
    writeFileSync(path.join(root, "CLAUDE.md"), "second words\n@../outside/allowed.md\n");
    const again = systemAgain("The base.", where, asked);
    let text = await again();
    expect(text.startsWith("The base.\n\n")).toBe(true);
    expect(text).toContain("second words");
    expect(text).toContain("allowed words");
    writeFileSync(path.join(root, "CLAUDE.md"), "third words\n@../outside/new.md\n");
    text = await again();
    expect(text).toContain("third words");
    expect(text).not.toContain("new words");
    expect(await systemAgain("The base.", where, "all")()).toContain("new words"); // never mode reads them, as at launch
  });

  describe("newSaved", () => {
    const begin = { project: "p", lead: "fake:a", version: "0.8.0", system: "New prompt.", box: false, tools };

    it("writes the start line and the name, then takes the lock", () => {
      const o = newSaved(dir, { ...begin, id: "fresh", print: true }, "my name");
      onTestFinished(o.release);
      expect(o.conversation).toMatchObject({ id: "fresh", system: "New prompt.", messages: [], prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
      expect(o.conversation.transcript!.failed).toBeNull();
      const lines = read(path.join(dir, "fresh.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toMatchObject([
        { t: "start", v: 1, id: "fresh", lead: "fake:a", print: true, system: "New prompt.", box: false, tools },
        { t: "name", name: "my name" },
      ]);
      expect(read(path.join(dir, "fresh.lock"))).toBe(String(process.pid));
    });

    it("goes on unsaved, taking no lock, when a file stands where the sessions folder should be", () => {
      const blocked = path.join(folder(), "sessions");
      writeFileSync(blocked, "not a folder");
      const o = newSaved(blocked, { ...begin, id: "fresh", print: false });
      expect(o.conversation.transcript!.failed).not.toBeNull();
      expect(read(blocked)).toBe("not a folder");
    });
  });

  // Release 8a plan, Task 7: the window's session, which /clear, /resume and /branch switch. Its lost lines are handed
  // out once and then marked reported; switching lets the last session's lock go and drops its lost lines unsaid.
  describe("WindowSessions", () => {
    const lost = (id: string) => [start(id), message(prompt("go")), { t: "subagent", at, id: "t1", description: "find x", file: "t1.jsonl" }];
    const lines = (file: string) => read(file).trim().split("\n").map((l) => JSON.parse(l));
    const marked = (id: string) => existsSync(path.join(dir, id, "subagents", "t1.jsonl"));
    const opened = (id: string) => {
      const s = openSaved(dir, id, { fork: false });
      if ("problem" in s) throw new Error(s.problem);
      return resumed(s, { tools, lead: "fake:a", prompt: SAVED, interactive: true });
    };

    it("hands out the open session's lost lines once, then marks them reported", () => {
      saved(dir, "w1", lost("w1"));
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, SAVED, opened("w1"));
      onTestFinished(() => w.release());
      expect(w.lost()).toEqual(["Subagent t1 (find x) had not finished when the session ended; its answer was lost."]);
      expect(marked("w1")).toBe(true);
      expect(w.lost()).toEqual([]);
    });

    it("lets the last session go on a switch, its lost lines dropped and never marked, and starts a fresh one", () => {
      saved(dir, "w2", lost("w2"));
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, SAVED, opened("w2"));
      onTestFinished(() => w.release());
      const next = w.fresh("fake:b", "Fresh prompt.");
      w.switched(next);
      expect(w.lost()).toEqual([]);
      expect(marked("w2")).toBe(false);
      const lock = openSession(dir, "w2"); // free for another window now
      expect(lock).not.toBeNull();
      lock!.release();
      expect(openSession(dir, next.conversation.id)).toBeNull(); // the new one's held
      const fresh = { t: "start", project: top, lead: "fake:b", print: false, system: "Fresh prompt.", tools };
      expect(lines(next.conversation.transcript!.file)).toMatchObject([fresh]);
    });

    it("opens /resume's pick under the launch's sandbox setting and prompt, as the launch opens one", () => {
      const file = saved(dir, "w4", talk("w4", "one"));
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, { box: true, full: "Box prompt." });
      const next = w.resume("w4", (saved) => saved);
      if ("problem" in next) throw new Error(next.problem);
      onTestFinished(next.release);
      expect(next.conversation.system).toBe("Box prompt.");
      expect(lines(file).at(-1)).toMatchObject({ t: "system", system: "Box prompt.", box: true });
      const fresh = w.fresh("fake:a", "Fresh prompt.");
      onTestFinished(fresh.release);
      expect(lines(fresh.conversation.transcript!.file)[0]).toMatchObject({ t: "start", system: "Fresh prompt.", box: true });
    });

    it("branches a copy of a session under its name, leaving the original as it was", () => {
      const file = saved(dir, "w3", talk("w3", "one"));
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, SAVED);
      const copy = w.branch("w3", "fake:a", "side");
      if ("problem" in copy) throw new Error(copy.problem);
      onTestFinished(copy.release);
      expect(copy.conversation.id).not.toBe("w3");
      expect(copy.conversation.messages).toEqual([prompt("one"), said("Done.")]);
      expect(lines(copy.conversation.transcript!.file).at(-1)).toMatchObject({ t: "name", name: "side" });
      expect(read(file)).toBe(talk("w3", "one").map((l) => `${JSON.stringify(l)}\n`).join(""));
    });
  });

  // Release 8a plan, Task 6: the window's picture numbers are one counter, the session's and the screen's, so a picture
  // made after a resume never takes a saved one's number.
  it("makes the lead's session with the Pictures the screen is given, which a loaded conversation raises", async () => {
    const ctx = await tempContext();
    onTestFinished(() => removeTree(ctx.root));
    const { session, pictures } = leadSession({ lead: new FakeProvider("a", []), tools: [], system: "s", ctx, bus: new Bus() });
    session.load({ id: "x", messages: [], system: "s", prompts: [], calls: [], nextPicture: 4, nextTask: 1 });
    expect(pictures.next()).toBe(4);
  });
});

// Release 7 plan, choice 21, with background commands (background commands plan, Task 3): a command run through start,
// foreground or background, gets the network line when it fails, in its result and in its log, so a background ending
// carries it too.
describe("networkNoted's start", () => {
  const LINE = "(The box's network is off, so nothing in it can reach the internet. To allow it, launch with --network on.)";
  const inner = (result: ExecResult, printed: string): Executor => ({
    exec: () => Promise.reject(new Error("exec is not used here")),
    start: () => {
      const log = new CommandLog();
      log.add(printed);
      return { log, done: Promise.resolve(result), stop: () => {} };
    },
  });

  it("adds the line to a failed command's stderr and to its log", async () => {
    const err = "curl: (6) Could not resolve host";
    const running = networkNoted(inner({ code: 6, signal: null, stdout: "", stderr: err }, err)).start("curl x", "/work");
    expect((await running.done).stderr).toBe(`${err}\n${LINE}`);
    expect(running.log.kept()).toBe(`${err}\n${LINE}`);
  });

  it("adds nothing to a command that succeeds, or to one that was stopped", async () => {
    for (const result of [{ code: 0, signal: null }, { code: null, signal: "SIGKILL" as const }]) {
      const running = networkNoted(inner({ ...result, stdout: "ok\n", stderr: "" }, "ok\n")).start("echo ok", "/work");
      expect((await running.done).stderr).toBe("");
      expect(running.log.kept()).toBe("ok\n");
    }
  });
});
