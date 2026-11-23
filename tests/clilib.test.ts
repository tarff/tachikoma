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
import { MEMORY_LINE } from "../src/core/prompt.js";
import { PermissionGate, visible } from "../src/core/permissions.js";
import { listSessions, openSession, sessionPaths, sessionsDir } from "../src/core/sessions.js";
import { Tasks } from "../src/core/tasks.js";
import { readTranscript } from "../src/core/transcript.js";
import type { Message, Setup, ToolSpec, Turn } from "../src/core/types.js";
import type { ExecResult, Executor } from "../src/exec/executor.js";
import { CommandLog } from "../src/exec/log.js";
import type { Hook } from "../src/hooks/config.js";
import { Hooks } from "../src/hooks/hooks.js";
import { type Answers, answersFor } from "../src/mcp/answers.js";
import type { ServerConfig } from "../src/mcp/config.js";
import type { McpSandbox } from "../src/mcp/place.js";
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
  type Opened,
  openSaved,
  prose,
  protectionOf,
  resolve,
  resumed,
  resumeArgs,
  type Ready,
  sandboxStart,
  screenMode,
  SITES_NOTE,
  scrollSpeed,
  serverQuestion,
  setupOf,
  statusSegments,
  stopSoon,
  turnAnswer,
  systemAgain,
  tilde,
  waitForBackground,
  WindowSessions,
} from "../src/clilib.js";
import { type Ended, Session } from "../src/core/session.js";
import { setupNote } from "../src/core/setup.js";
import { HEADLESS_LIMIT, MOST_TIMEOUT, shellTools } from "../src/tools/commands.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";
import { callTool, FakeProvider, removeTree, reply, standInRun, tempContext, usage } from "./helpers.js";
import { standinBox } from "./mcp/fake.js";

describe("the instruction files on screen", () => {
  const home = path.resolve("/home/me");
  const proj = path.resolve("/work/proj");
  const r = {
    text: "...",
    read: [
      { path: path.join(home, ".claude", "CLAUDE.md"), size: 1200, type: "User" as const },
      { path: path.join(proj, "AGENTS.md"), size: 3100, type: "Project" as const },
    ],
    left: [{ path: path.resolve("/elsewhere/x.md"), why: "not allowed" }],
  };

  // TUI design pass, Task 6: the start-up box names the files read, so the line keeps only those left out.
  it("names only the files left out, the user's folder as ~, and why; nothing when none was", () => {
    expect(instructionsLine(r, home)).toBe(`Instructions left out: ${path.resolve("/elsewhere/x.md")} (not allowed)`);
    const two = [...r.left, { path: path.join(home, "notes", "a\u001bb.md"), why: "not found" }];
    expect(instructionsLine({ ...r, left: two }, home)).toBe(
      `Instructions left out: ${path.resolve("/elsewhere/x.md")} (not allowed), ${path.join("~", "notes", "a\\u001bb.md")} (not found)`,
    );
    expect(instructionsLine({ ...r, left: [] }, home)).toBeNull();
    expect(instructionsLine({ text: "", read: [], left: [] }, home)).toBeNull();
  });

  it("writes the user's folder as ~, and any other path as it is", () => {
    expect(tilde(home, home)).toBe("~");
    expect(tilde(path.join(home, "Agent Harness"), home)).toBe(path.join("~", "Agent Harness"));
    expect(tilde(`${home}2`, home)).toBe(`${home}2`); // a folder beside home, whose name starts with home's
    expect(tilde(proj, home)).toBe(proj);
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
  // With the sandbox on, the stand-in box, in which nothing starts here (8c-2a plan, Task 6): live link, unless `kind`
  // says copy.
  const servers = (
    configs: ServerConfig[], network: "on" | "off" | "sites" | "none", answers: () => Answers, kind?: "live" | "copy",
  ) => {
    const box = network === "none" ? {} : { box: standinBox(tmpdir(), { kind }).box };
    const sites = network === "sites" ? { sites: [] } : {}; // 8c-2b plan, Step 9: no site in force
    return new Servers(configs, {
      root: tmpdir(), env: {}, bus: new Bus(), answers, network, ...box, ...sites, lead: () => "fake:a",
    });
  };
  const none = (): Answers => ({ get: () => undefined, set: () => {}, reset: () => {} });

  it("asks about a project's local server with its command and arguments, and a remote one at its address, escaped", () => {
    const tv = local("tv", ["-y", "tradingview-mcp"]);
    expect(serverQuestion(tv, null)).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json on this computer: npx -y tradingview-mcp? [y/n]',
    );
    // A command or argument that is empty or holds a space or a quote is shown in quotes, a quote in it as \", so where
    // each ends can be seen.
    expect(serverQuestion(local("a\u001b[2Jb", ["C:\\my server\\x.js", "", 'say "hi"']), null)).toBe(
      'Start the MCP server "a\\u001b[2Jb" from this project\'s .mcp.json on this computer: ' +
        'npx "C:\\my server\\x.js" "" "say \\"hi\\""? [y/n]',
    );
    const remote = server("sanity", { kind: "http", url: "https://mcp.sanity.io/\u202e", headers: {} });
    expect(serverQuestion(remote, null)).toBe(
      'Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.sanity.io/\\u202e? [y/n]',
    );
  });

  // Choice 48: as .mcp.json writes it, so a key filled in from the environment never reaches the screen.
  it("shows the entry as written, ${VAR} unfilled, never the value filled in", () => {
    const filled = { kind: "stdio" as const, command: "npx", args: ["--key=sk-secret-123"], env: {} };
    const tv = server("tv", filled, "project", { command: "npx", args: ["--key=${TOKEN}"] });
    expect(serverQuestion(tv, null)).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json on this computer: npx --key=${TOKEN}? [y/n]',
    );
    const url = { kind: "http" as const, url: "https://mcp.example.com/mcp?key=sk-secret-123", headers: {} };
    const sanity = server("sanity", url, "project", { url: "https://mcp.example.com/mcp?key=${TOKEN}", headers: {} });
    expect(serverQuestion(sanity, null)).toBe(
      'Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.example.com/mcp?key=${TOKEN} (sends TOKEN)? [y/n]',
    );
    for (const c of [tv, sanity]) expect(serverQuestion(c, null)).not.toContain("sk-secret-123");
  });

  // Choice 49: the variables a local entry sets, names only, in the file's order, escaped and quoted as the command is; a
  // remote server's headers are not named, only the variables they read (choice 64, below).
  it("names the variables a local server's entry sets, never their values, and no headers", () => {
    const env = { NODE_OPTIONS: "--require ./steal.js", "MY KEY\u001b": "sk-secret-123" };
    expect(serverQuestion(local("tv", ["server.js"], "project", env), null)).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json on this computer: ' +
        'npx server.js (sets NODE_OPTIONS, "MY KEY\\u001b")? [y/n]',
    );
    const headers = { kind: "http" as const, url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer sk-secret-123" } };
    expect(serverQuestion(server("sanity", headers), null)).toBe(
      'Connect to the MCP server "sanity" from this project\'s .mcp.json at https://mcp.example.com/mcp? [y/n]',
    );
  });

  // Choice 64: the variables a remote entry's address and headers read, as written, names only, in the file's order, each
  // once, escaped and quoted as a local one's are; one that reads none names nothing.
  it("names the variables a remote server's address and headers read, never their values", () => {
    const filled = { kind: "http" as const, url: "https://tools.example.dev/mcp", headers: { Authorization: "Bearer sk-secret-123" } };
    const one = server("tools", filled, "project", { url: "https://tools.example.dev/mcp", headers: { Authorization: "Bearer ${TICKETS_TOKEN}" } });
    expect(serverQuestion(one, null)).toBe(
      'Connect to the MCP server "tools" from this project\'s .mcp.json at https://tools.example.dev/mcp ' +
        "(sends TICKETS_TOKEN)? [y/n]",
    );
    const headers = { Authorization: "Bearer ${TICKETS_TOKEN}", "X-Team": "${TEAM}", "X-Key": "${MY KEY\u001b:-none}" };
    const several = server("tools", filled, "project", { url: "https://${HOST:-tools.example.dev}/mcp?team=${TEAM}", headers });
    expect(serverQuestion(several, null)).toBe(
      'Connect to the MCP server "tools" from this project\'s .mcp.json at https://${HOST:-tools.example.dev}/mcp?team=${TEAM} ' +
        '(sends HOST, TEAM, TICKETS_TOKEN, "MY KEY\\u001b")? [y/n]',
    );
    const none = server("tools", filled, "project", { url: "https://tools.example.dev/mcp", headers: { "X-Team": "core" } });
    expect(serverQuestion(none, null)).toBe(
      'Connect to the MCP server "tools" from this project\'s .mcp.json at https://tools.example.dev/mcp? [y/n]',
    );
    for (const c of [one, several, none]) expect(serverQuestion(c, null)).not.toContain("sk-secret-123");
  });

  // 8c-2a plan, Task 8 (design, "A project's servers"; choice 8): the question says where a local server runs, and
  // whether a remote one's headersHelper runs, after 8c's address and its (sends ...); the helper escaped.
  it("says where a local server runs, and whether a remote one's headersHelper runs on this computer", () => {
    const tv = local("tv", ["server.js"]);
    expect(serverQuestion(tv, { kind: "copy", network: "off" })).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json inside the sandbox (copy, network off): ' +
        "npx server.js? [y/n]",
    );
    expect(serverQuestion(tv, { kind: "live", network: "on" })).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json inside the sandbox (live link, network on): ' +
        "npx server.js? [y/n]",
    );
    // 8c-2b plan, Step 10 (W12).
    expect(serverQuestion(tv, { kind: "copy", network: "sites", sites: [] })).toBe(
      'Start the MCP server "tv" from this project\'s .mcp.json inside the sandbox (copy, network sites): ' +
        "npx server.js? [y/n]",
    );
    const filled = { kind: "http" as const, url: "https://x/mcp", headers: { Authorization: "Bearer sk-secret-123" } };
    const helper = "get-token \u001b[2J";
    const written = { url: "https://x/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, headersHelper: helper };
    const far = server("far", { ...filled, headersHelper: helper }, "project", written);
    expect(serverQuestion(far, null)).toBe(
      'Connect to the MCP server "far" from this project\'s .mcp.json at https://x/mcp (sends TOKEN), ' +
        "running its headersHelper on this computer: get-token \\u001b[2J? [y/n]",
    );
    expect(serverQuestion(far, { kind: "live", network: "on" })).toBe(
      'Connect to the MCP server "far" from this project\'s .mcp.json at https://x/mcp (sends TOKEN), ' +
        "without its headersHelper? [y/n]",
    );
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
    const ask = async (question: string) => (asked.push(question), replies.shift()!);
    await askServers(configs, null, () => answersFor(top, data), ask, (line) => failed.push(line));
    expect(asked).toEqual([serverQuestion(local("yes"), null), serverQuestion(local("no"), null)]);
    expect(failed).toEqual([]);
    const kept = answersFor(top, data);
    const kept3 = ["old", "yes", "no"].map((name) => kept.get(name, `as written: ${name}`, "host"));
    expect(kept3).toEqual([true, true, false]);
    // Kept for this computer, not with no setup: a lookup with none finds only an answer kept with none, as old's is.
    const noSetup = ["old", "yes", "no"].map((name) => kept.get(name, `as written: ${name}`));
    expect(noSetup).toEqual([true, undefined, undefined]);
    // Nothing read nor asked without a project server.
    const never = async () => expect.unreachable();
    const unread = () => expect.unreachable("no project server, so no answers are read");
    await askServers([local("mine", [], "user")], null, unread, never, never);
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
    const ask = async () => replies.shift()!;
    await askServers([local("yes"), local("no\u001b")], null, blocked, ask, (line) => failed.push(line));
    const unsaved = (name: string) => new RegExp(`^Your answer for ${name} could not be saved \\(.+\\); Tachikoma asks again at the next launch\\.$`);
    expect(failed).toEqual([expect.stringMatching(unsaved("yes")), expect.stringMatching(unsaved("no\\\\u001b"))]);
    const kept = ["yes", "no\u001b"].map((name) => answers!.get(name, `as written: ${name}`, "host"));
    expect(kept).toEqual([true, false]);
    // Kept for this computer, not with no setup: a lookup with none finds only an answer kept with none.
    const noSetup = ["yes", "no\u001b"].map((name) => answers!.get(name, `as written: ${name}`));
    expect(noSetup).toEqual([undefined, undefined]);
  });

  // 8c-2a plan, Task 8 (design, "A project's servers"; choice 2 (b)): one answer per server and setup. Each new setup
  // is asked about once, going back to one answered asks nothing, and each answer counts where Servers reads it. With
  // the network off the remote server does not start, so it is not asked about; with the sandbox on its helper does not
  // run, so it is asked about again without it.
  it("asks about each project server once per setup, and the answer counts where Servers reads it", async () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-mcp-"));
    onTestFinished(() => removeTree(top));
    const data = path.join(top, "data", "tachikoma");
    const tv = local("tv", ["server.js"]);
    const entry = { kind: "http" as const, url: "https://x/mcp", headers: {}, headersHelper: "get-token" };
    const far = server("far", entry, "project", { url: "https://x/mcp", headers: {}, headersHelper: "get-token" });
    const copyOff: McpSandbox = { kind: "copy", network: "off" };
    const liveOff: McpSandbox = { kind: "live", network: "off" };
    const copyOn: McpSandbox = { kind: "copy", network: "on" };
    const runs: [McpSandbox, string[]][] = [
      [null, [serverQuestion(tv, null), serverQuestion(far, null)]],
      [null, []],
      [copyOff, [serverQuestion(tv, copyOff)]],
      [liveOff, [serverQuestion(tv, liveOff)]],
      [copyOn, [serverQuestion(tv, copyOn), serverQuestion(far, copyOn)]],
      [null, []],
    ];
    for (const [sandbox, questions] of runs) {
      const asked: string[] = [];
      await askServers([tv, far], sandbox, () => answersFor(top, data), async (q) => (asked.push(q), true), () => {});
      expect(asked).toEqual(questions);
      // Each yes starts its server in this setup: none is left waiting; the remote one is off with the network off.
      const network = sandbox?.network ?? "none";
      const listed = servers([tv, far], network, () => answersFor(top, data), sandbox?.kind).list();
      expect(listed.map((s) => s.state.is)).toEqual(["starting", network === "off" ? "off" : "starting"]);
    }
    // With the sandbox off, the remote server's yes is kept for its helper running.
    expect(answersFor(top, data).get("far", far.written, "helper")).toBe(true);
  });

  // Decision 11: a line saved by 8c, without a setup, counts on this computer, and not for live link with the network
  // on.
  it("counts an 8c answer on this computer, and asks again for live link with the network on", async () => {
    const top = mkdtempSync(path.join(tmpdir(), "tachi-clilib-mcp-"));
    onTestFinished(() => removeTree(top));
    const data = path.join(top, "data", "tachikoma");
    const tv = local("tv", ["server.js"]);
    answersFor(top, data).set("tv", tv.written, true);
    const asked: string[] = [];
    const ask = async (q: string) => (asked.push(q), true);
    await askServers([tv], null, () => answersFor(top, data), ask, () => {});
    expect(asked).toEqual([]);
    await askServers([tv], { kind: "live", network: "on" }, () => answersFor(top, data), ask, () => {});
    expect(asked).toEqual([serverQuestion(tv, { kind: "live", network: "on" })]);
  });

  // In -p every project server without a yes, one answered no included (the plan's line, Task 9's spec review).
  // 8c-2a plan, Task 6 (choice 3): with the network off, the line once for the host and remote servers it keeps off,
  // then in -p the skip lines, as the project's servers now run in the box.
  it("says once that host and remote servers are off, and in -p names each project server without a yes", () => {
    const off =
      'MCP servers marked "host" and remote servers are off: the sandbox\'s network is off, and outside the box ' +
      "nothing keeps them off the web. Start with --network on to use them.";
    const skipped = (name: string) =>
      `MCP server ${name} from .mcp.json was skipped: -p starts only the project's servers ` +
      "you said yes to in the window.";
    const mine = { ...local("mine", [], "user"), host: true as const };
    const far = server("far", { kind: "http", url: "https://mcp.example.com/mcp", headers: {} }, "user");
    const configs = [mine, far, local("yes"), local("no"), local("new")];
    const given = (): Answers => ({ get: (name) => ({ yes: true, no: false })[name], set: () => {}, reset: () => {} });
    expect(mcpLines(servers(configs, "off", given), { print: true })).toEqual([off, skipped("no"), skipped("new")]);
    expect(mcpLines(servers(configs, "off", given), { print: false })).toEqual([off]);
    expect(mcpLines(servers([far], "off", given), { print: true })).toEqual([off]);
    expect(mcpLines(servers(configs, "none", given), { print: true })).toEqual([skipped("no"), skipped("new")]);
    // Nothing in the window when nothing is off, and no line with no servers.
    expect(mcpLines(servers(configs, "none", given), { print: false })).toEqual([]);
    expect(mcpLines(servers(configs.slice(2), "off", given), { print: false })).toEqual([]);
    expect(mcpLines(servers([], "off", none), { print: true })).toEqual([]);
  });

  // 8c-2b plan, Step 9 (the design's line 3): with the allowed sites, the line once for the host servers it keeps off;
  // a remote one that is off says so in /mcp only.
  it("says once that host servers are off with the allowed sites, and nothing for remote ones", () => {
    const line = 'MCP servers marked "host" are off: the sandbox\'s network is limited to its allowed sites.';
    const host = (name: string) => ({ ...local(name, [], "user"), host: true as const });
    const far = server("far", { kind: "http", url: "https://mcp.example.com/mcp", headers: {} }, "user");
    expect(mcpLines(servers([host("a"), host("b"), far], "sites", none), { print: false })).toEqual([line]);
    expect(mcpLines(servers([host("a"), far], "sites", none), { print: true })).toEqual([line]);
    expect(mcpLines(servers([far, local("mine", [], "user")], "sites", none), { print: true })).toEqual([]);
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

  // PR #18 fixes' review: the session takes waiting entries again after each round of tool calls, so a turn that uses a
  // tool must still hold back an ending it was not started for, one waiting before it or one that arrives during it.
  it.each([
    ["waiting before the turn", false],
    ["arriving during it", true],
  ])("gives an ending %s its own turn when the turn before uses a tool", async (_, during) => {
    const s = await setup([both("node a.js", "node b.js"), reply("Started both."), callTool("c3", "shell_output", { id: "t9" }), reply("a ended."), reply("b ended.")]);
    const stop = new AbortController();
    const first = await s.first(stop.signal);
    s.runs[0]!.end(ok(""));
    if (during) s.bus.on("message", (m) => void (carriesT1(m) && s.runs[1]!.end(ok(""))));
    else s.runs[1]!.end(ok(""));
    await Promise.all(s.tasks.all.slice(0, during ? 1 : 2).map((t) => t.done));
    expect(await s.wait(first, stop.signal)).toBeUndefined();
    expect(s.answers).toEqual(["Started both.", "a ended.", "b ended."]);
    expect(s.lead.seen).toHaveLength(5);
    expect(s.sent(2)).toContain("Background command t1 (node a.js) ended with exit code 0, with no new output.");
    expect(s.sent(3)).toContain("No task t9."); // the tool's round, after which the session takes again
    expect([s.sent(2), s.sent(3)].join()).not.toContain("Background command t2");
    expect(s.sent(4)).toContain("Background command t2 (node b.js) ended with exit code 0, with no new output.");
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
    expect(() => statusSegments("lead,nope")).toThrow(
      "--status must be one of: lead, context, tokens, cost, mode, errors, memory, project, time, tasks, tools " +
        '(got "nope")',
    );
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

// System prompt plan, Task 1 (decision 3): git as found where the model's commands run, from the files alone.
describe("setupOf", () => {
  let top: string;
  beforeAll(() => {
    top = mkdtempSync(path.join(tmpdir(), "tachi-setup-"));
  });
  afterAll(() => removeTree(top));
  const folder = (...names: string[]) => {
    const d = path.join(top, ...names);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const repo = (d: string) => {
    mkdirSync(path.join(d, ".git"), { recursive: true });
    writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
    return d;
  };

  it("finds no repository in a plain folder, in each mode", () => {
    const d = folder("plain");
    expect(setupOf(d, "off", "on")).toEqual({ sandbox: "off", git: "none" });
    expect(setupOf(d, "live", "off")).toEqual({ sandbox: "live", network: "off", git: "none" });
    expect(setupOf(d, "live", "sites")).toEqual({ sandbox: "live", network: "sites", git: "none" }); // 8c-2b, Step 10
    expect(setupOf(d, "copy", "on")).toEqual({ sandbox: "copy", network: "on", git: "copy" });
  });

  it("finds the project's own repository with no sandbox and in live link", () => {
    const d = repo(folder("own"));
    expect(setupOf(d, "off", "off")).toEqual({ sandbox: "off", git: "repo" });
    expect(setupOf(d, "live", "on")).toEqual({ sandbox: "live", network: "on", git: "repo" });
  });

  // Only the project folder is mounted at /work, so a repository above it is not in the box.
  it("finds a repository above the project with no sandbox, but not in live link", () => {
    const d = folder("above", "sub");
    repo(path.join(top, "above"));
    expect(setupOf(d, "off", "off").git).toBe("repo");
    expect(setupOf(d, "live", "off").git).toBe("none");
  });

  it("says live link's git does not work when the project's .git names a git folder outside it", () => {
    const outside = repo(folder("elsewhere"));
    const d = folder("worktree");
    writeFileSync(path.join(d, ".git"), `gitdir: ${path.join(outside, ".git")}\n`);
    expect(setupOf(d, "live", "off").git).toBe("outside");
    expect(setupOf(d, "off", "off").git).toBe("repo");
  });

  // System prompt plan, Task 1's code review: only a git folder outside the project gives "outside".
  it("finds live link's git when the project's .git names a git folder inside it", () => {
    const d = folder("inside");
    mkdirSync(path.join(d, ".realgit"), { recursive: true });
    writeFileSync(path.join(d, ".realgit", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(d, ".git"), "gitdir: .realgit\n");
    expect(setupOf(d, "live", "off").git).toBe("repo");
  });

  // PR #23's review: a `.git` file git refuses ("invalid gitfile format") is no repository in live link, as it is
  // with no sandbox.
  it("finds no repository when the project's .git is a file git would refuse", () => {
    const d = folder("malformed");
    writeFileSync(path.join(d, ".git"), "not a gitfile\n");
    expect(setupOf(d, "live", "off").git).toBe("none");
    expect(setupOf(d, "off", "off").git).toBe("none");
  });

  // PR #23's review: a `.git` link leading nowhere is not the project's own repository, and live link does not take
  // the one above it instead.
  it("finds no repository in live link when the project's .git is a link leading nowhere", () => {
    repo(folder("dangling"));
    const d = folder("dangling", "project");
    symlinkSync(path.join(top, "dangling", "missing"), path.join(d, ".git"), "junction");
    expect(setupOf(d, "live", "off").git).toBe("none");
  });

  it("always gives copy mode's own repository", () => {
    expect(setupOf(repo(folder("copied")), "copy", "off").git).toBe("copy");
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

  // 8c-2b plan, Step 11 (decision 15; the design's choice 2): `sites` is offered now, the flag winning over the file as
  // for off and on. The list is its own entry, which the network's value never changes, so switching between on and
  // sites keeps it.
  it("the flag wins over the settings file, and switching between on and sites keeps the list", () => {
    const file = { network: "on" as const, allowedSites: [{ name: "github.com", port: 443 }] };
    expect(resolve({ network: "sites" }, {}, file).network).toBe("sites");
    expect(resolve({}, {}, { ...file, network: "sites" }).network).toBe("sites");
    expect(resolve({ network: "on" }, {}, { ...file, network: "sites" }).network).toBe("on");
    expect(file.allowedSites).toEqual([{ name: "github.com", port: 443 }]);
  });

  // Release 8d plan, step 15 and question Q13: one answer, off, Tachikoma's own palace or the user's program at a path;
  // --no-memory wins over the file, for this launch.
  it("takes memory as off, Tachikoma's own or the user's program, --no-memory winning over the file", () => {
    const use = path.resolve("/tools/mempalace-mcp");
    expect(resolve({}, {}, {}).memory).toBe("own");
    expect(resolve({}, {}, { memory: true }).memory).toBe("own");
    expect(resolve({}, {}, { memory: false }).memory).toBe("off");
    expect(resolve({}, {}, { memory: { use } }).memory).toEqual({ use });
    for (const memory of [undefined, true, false, { use }]) {
      expect(resolve({ "no-memory": true }, {}, { memory }).memory).toBe("off");
    }
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
    expect(() => resolve({ network: "x" }, {}, { network: "off" })).toThrow(
      '--network must be one of: off, on, sites (got "x")',
    );
    expect(() => resolve({ effort: "x" }, {}, {})).toThrow('--effort must be one of: low, medium, high, xhigh, max (got "x")');
    expect(() => resolve({ "max-tasks": "1e1" }, {}, { maxTasks: 2 })).toThrow('--max-tasks must be a whole number from 1 (got "1e1")');
    expect(() => resolve({ status: "nope" }, {}, { status: ["lead"] })).toThrow(
      "--status must be one of: lead, context, tokens, cost, mode, errors, memory, project, time, tasks, tools " +
        '(got "nope")',
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
  // The box setups as setup.test.ts has them; OFF has git "none", per the system prompt plan's Task 6.
  const OFF: Setup = { sandbox: "off", git: "none" };
  const LIVE_OFF: Setup = { sandbox: "live", network: "off", git: "repo" };
  const LIVE_ON: Setup = { sandbox: "live", network: "on", git: "repo" };
  const COPY_ON: Setup = { sandbox: "copy", network: "on", git: "copy" };
  // This launch's system prompt when it is the one the sessions were saved under: the same sandbox setting.
  const SAVED = { setup: OFF, full: "Saved prompt." };
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
    type As = {
      fork?: boolean;
      as?: ToolSpec[];
      lead?: string;
      prompt?: { setup: Setup; full: string };
      interactive?: boolean;
    };
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
      const box = { setup: LIVE_OFF, full: "Box prompt.\n\nRules, read again." };
      const changed = "The sandbox setting has changed since this session was saved, so the model is told this launch's shell and project folder";
      const b = open("boxed", { prompt: box, as: other }); // the box's shell tool is another
      expect(b.conversation.system).toBe(box.full);
      expect(b.conversation.messages).toEqual([prompt("hi"), said("Done.")]);
      expect(b.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${changed}, and its earlier replies are sent without their thinking.`]);
      expect(lines(file).at(-1)).toMatchObject({ t: "system", system: box.full, box: true, setup: LIVE_OFF });
      // As the session's first request under the box's tools writes them (choice 46), then its reply.
      b.conversation.transcript!.write({ t: "tools", tools: other });
      b.conversation.transcript!.write({ t: "message", message: prompt("again") });
      b.conversation.transcript!.write({ t: "message", message: said("Done again.", native) });
      b.release();
      // In the box again, its prompt worded otherwise, the folder typed in other letters for one: nothing more is written
      // or said, the tools line neither, and only the first reply goes without its thinking.
      const again = open("boxed", { prompt: { setup: LIVE_OFF, full: "Box prompt for C:\\OTHER\\CASE." }, as: other });
      expect(again.conversation.system).toBe(box.full);
      expect(again.conversation.messages).toEqual([prompt("hi"), said("Done."), prompt("again"), said("Done again.", native)]);
      expect(again.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
      again.release();
      expect(lines(file).filter((l) => l.t === "system")).toHaveLength(1);
      // The same setting as saved, its prompt worded otherwise, keeps the saved prompt; a reply without thinking loses none.
      const same = open("unthought", { prompt: { setup: OFF, full: "Other words." } });
      expect(same.conversation.system).toBe("Saved prompt.");
      same.release();
      const plain = open("unthought", { prompt: box });
      expect(plain.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${changed}.`]);
      expect(plain.conversation.system).toBe(box.full);
    });

    // System prompt plan, Task 6 (choice 2 (c)): the whole setup is compared, the box's mode and network included, git
    // not (decision 12); a change the sandbox setting's line does not fit says the setup changed.
    const SETUP_CHANGED =
      "The sandbox's setup has changed since this session was saved, so the model is told this launch's setup";
    const SETUP_UNKNOWN =
      "This session was saved before Tachikoma recorded the sandbox's mode and network, so the model is told this " +
      "launch's setup";
    const SANDBOX_CHANGED =
      "The sandbox setting has changed since this session was saved, so the model is told this launch's shell and " +
      "project folder";
    const chat = (first: object) => [first, message(prompt("hi")), message(said("Done."))];

    it("rebuilds the prompt of a session saved under another network or mode, saying the setup changed, once", () => {
      const cases: [string, Setup, Setup][] = [
        ["network", LIVE_OFF, LIVE_ON],
        ["mode", LIVE_ON, COPY_ON],
      ];
      for (const [id, was, now] of cases) {
        const file = saved(dir, id, chat({ ...start(id), box: true, setup: was }));
        const p = { setup: now, full: `Box prompt, ${id}.` };
        const o = open(id, { prompt: p });
        expect(o.conversation.system).toBe(p.full);
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${SETUP_CHANGED}.`]);
        expect(lines(file).at(-1)).toMatchObject({ t: "system", system: p.full, box: true, setup: now });
        o.release();
        const again = open(id, { prompt: p });
        expect(again.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        again.release();
        expect(lines(file).filter((l) => l.t === "system")).toHaveLength(1);
      }
    });

    // 8d plan, step 27 (Q21): memory on or off at this launch is a second cause of a rebuilt prompt, kept apart from
    // the setup: whether the saved prompt holds the memory line. Memory alone says the tools line, and only when
    // thinking was left out; with the setup too, the setup's own line alone.
    describe("and memory", () => {
      const withLine = `Saved prompt.\n\n${MEMORY_LINE}`;
      const ON = { setup: OFF, full: withLine };
      const CHANGED =
        "The tools have changed since this session was saved, so its earlier replies are sent without their thinking.";
      const search = { name: "memory_search", description: "Searches.", inputSchema: { type: "object" } };
      const remembering: ToolSpec[] = [...tools, search];
      const systems = (file: string) => lines(file).filter((l) => l.t === "system");

      it("gives a session saved without the memory line, resumed with memory on, it and the tools line, once", () => {
        const file = saved(dir, "mem-on", [start("mem-on"), message(prompt("hi")), message(said("Done.", native))]);
        const o = open("mem-on", { prompt: ON, as: remembering });
        expect(o.conversation.system).toBe(withLine);
        expect(o.conversation.messages).toEqual([prompt("hi"), said("Done.")]);
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi.", CHANGED]);
        expect(lines(file).at(-1)).toMatchObject({ t: "system", system: withLine, box: false, setup: OFF });
        o.release();
        const again = open("mem-on", { prompt: ON, as: remembering });
        expect(again.conversation.system).toBe(withLine);
        expect(again.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        again.release();
        expect(systems(file)).toHaveLength(1);
      });

      it("takes the line away with the tools from a session saved with it, resumed with memory off, once", () => {
        const first = { ...start("mem-off", { tools: remembering }), system: withLine };
        const file = saved(dir, "mem-off", [first, message(prompt("hi")), message(said("Done.", native))]);
        const o = open("mem-off");
        expect(o.conversation.system).toBe("Saved prompt.");
        expect(o.conversation.messages).toEqual([prompt("hi"), said("Done.")]);
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi.", CHANGED]);
        o.release();
        const again = open("mem-off");
        expect(again.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        again.release();
        expect(systems(file)).toEqual([expect.objectContaining({ system: "Saved prompt.", setup: OFF })]);
      });

      it("rebuilds the prompt of a session with no Anthropic reply when memory changed, saying nothing", () => {
        const file = saved(dir, "mem-plain", chat(start("mem-plain")));
        const o = open("mem-plain", { prompt: ON, as: remembering });
        expect(o.conversation.system).toBe(withLine);
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        o.release();
        expect(systems(file)).toEqual([expect.objectContaining({ system: withLine })]);
      });

      it("says only the setup's own line when the setup and memory both changed", () => {
        saved(dir, "mem-box", [start("mem-box"), message(prompt("hi")), message(said("Done.", native))]);
        const box = { setup: LIVE_OFF, full: `Box prompt.\n\n${MEMORY_LINE}` };
        const o = open("mem-box", { prompt: box, as: remembering });
        expect(o.conversation.system).toBe(box.full);
        expect(o.lines.map((l) => l.text)).toEqual([
          "Resumed: hi.",
          `${SANDBOX_CHANGED}, and its earlier replies are sent without their thinking.`,
        ]);
      });

      it("keeps the saved prompt untouched and says nothing when memory is the way it was saved", () => {
        const first = { ...start("mem-same", { tools: remembering }), system: withLine };
        const file = saved(dir, "mem-same", [first, message(prompt("hi")), message(said("Done.", native))]);
        const o = open("mem-same", { prompt: { setup: OFF, full: `Other words.\n\n${MEMORY_LINE}` }, as: remembering });
        expect(o.conversation.system).toBe(withLine);
        expect(o.conversation.messages).toEqual([prompt("hi"), said("Done.", native)]);
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        o.release();
        expect(systems(file)).toEqual([]);
      });
    });

    // Release 8e plan, step 15 (Q26; Codex round 2, point 10): the opening hands out whether the session got this launch's
    // prompt, just built, so the launch fires InstructionsLoaded only then: never by comparing prompt texts or looking for
    // the rebuilt line, which a change of the memory line alone does not say.
    it("says whether the session got this launch's prompt: no for the same setup, yes for another, and yes for the memory line alone", () => {
      for (const id of ["q26-same", "q26-box", "q26-memory"]) saved(dir, id, chat(start(id)));
      const same = open("q26-same", { prompt: { setup: OFF, full: "Other words." } });
      expect([same.built, same.conversation.system]).toEqual([false, "Saved prompt."]);
      const box = open("q26-box", { prompt: { setup: LIVE_OFF, full: "Box prompt." } });
      expect([box.built, box.conversation.system]).toEqual([true, "Box prompt."]);
      const memory = open("q26-memory", { prompt: { setup: OFF, full: `Saved prompt.\n\n${MEMORY_LINE}` } });
      expect([memory.built, memory.conversation.system]).toEqual([true, `Saved prompt.\n\n${MEMORY_LINE}`]);
      expect(memory.lines.map((l) => l.text)).toEqual(["Resumed: hi."]); // no rebuilt line
    });

    it("rebuilds the prompt of a session saved in the sandbox before the setup was recorded, saying why", () => {
      const inBox = saved(dir, "oldbox", chat({ ...start("oldbox"), box: true }));
      saved(dir, "oldhost", chat({ ...start("oldhost"), box: true }));
      const o = open("oldbox", { prompt: { setup: LIVE_OFF, full: "Box prompt." } });
      expect(o.conversation.system).toBe("Box prompt.");
      expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${SETUP_UNKNOWN}.`]);
      expect(lines(inBox).at(-1)).toMatchObject({ t: "system", system: "Box prompt.", box: true, setup: LIVE_OFF });
      // Opened with no sandbox: the sandbox setting's line.
      const host = open("oldhost", { prompt: { setup: OFF, full: "Host prompt." } });
      expect(host.conversation.system).toBe("Host prompt.");
      expect(host.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${SANDBOX_CHANGED}.`]);
    });

    it("keeps the prompt of a session saved with no sandbox before the setup was recorded, opened with none", () => {
      for (const [id, first] of [["oldoff", { ...start("oldoff"), box: false }], ["nobox", start("nobox")]] as const) {
        const file = saved(dir, id, chat(first));
        const o = open(id, { prompt: { setup: OFF, full: "Other words." } });
        expect(o.conversation.system).toBe("Saved prompt.");
        expect(o.lines.map((l) => l.text)).toEqual(["Resumed: hi."]);
        o.release();
        expect(lines(file).filter((l) => l.t === "system")).toHaveLength(0);
      }
    });

    // What the model was told goes with the conversation, for the notes (Task 7): the start line's date and setup and
    // each note since, or for an older session its sandbox setting alone.
    it("gives the conversation what the model was told, as the transcript reads it", () => {
      const text = "This note is from Tachikoma, not the user: today's date is now 2026-11-18.";
      const note = { type: "text", text, from: "note", note: { date: "2026-11-18" } };
      const noted = { t: "message", at, message: { role: "user", parts: [{ type: "text", text: "hi" }, note] } };
      const told = (id: string) => {
        const r = readTranscript(sessionPaths(dir, id).file, sessionPaths(dir, id).pictures);
        if ("problem" in r) throw new Error(r.problem);
        return r.told;
      };
      saved(dir, "recorded", [{ ...start("recorded"), box: true, date: "2026-11-17", setup: LIVE_OFF }, noted]);
      saved(dir, "legacy", chat(start("legacy")));
      expect(told("recorded")).toEqual({ date: "2026-11-18", setup: LIVE_OFF });
      const recorded = open("recorded", { prompt: { setup: LIVE_OFF, full: "Box." } });
      expect(recorded.conversation.told).toEqual(told("recorded"));
      expect(told("legacy")).toEqual({ setup: { sandbox: "off" } });
      expect(open("legacy").conversation.told).toEqual(told("legacy"));
    });

    // System prompt plan, Task 7: a resumed conversation's first request, by a lead session as cli.tsx makes it, given
    // the launch's setup `now` and today's date; the notes it sent.
    const TODAY = "2026-11-17";
    const host = { root: "C:\\proj", platform: "win32" } as const;
    const sendAfter = async (o: Opened, now: Setup, today = TODAY) => {
      const lead = new FakeProvider("a", [reply("ok")]);
      const session = new Session({
        lead, tools: [], system: o.conversation.system, ctx: await tempContext(), bus: new Bus(),
        setup: { now: () => now, today: () => today, root: host.root, platform: host.platform },
      });
      session.load(o.conversation);
      await session.send("next");
      return lead.seen[0]!.at(-1)!.parts.flatMap((p) => (p.type === "text" && p.from === "note" ? [p.text] : []));
    };
    // A session saved with this change, its start line recording today's date and `setup`.
    const savedOn = (id: string, setup: Setup) =>
      saved(dir, id, chat({ ...start(id), box: setup.sandbox !== "off", date: TODAY, setup }));
    const inBox = { setup: LIVE_ON, full: "Box prompt." };

    it("tells a conversation resumed under another setup of it in its next request, until one has", async () => {
      const file = savedOn("moved", OFF);
      open("moved", { prompt: inBox }).release(); // closed without a prompt
      const again = open("moved", { prompt: inBox });
      expect(lines(file).filter((l) => l.t === "system")).toHaveLength(1);
      expect(await sendAfter(again, LIVE_ON)).toEqual([setupNote(OFF, LIVE_ON, host)]);
      again.release();
      // Told once sent: the note's message is saved, as the session wrote it through the conversation's transcript.
      expect(await sendAfter(open("moved", { prompt: inBox }), LIVE_ON)).toEqual([]);
    });

    it("sends no setup note to a conversation resumed under its first setup again", async () => {
      const file = savedOn("back", OFF);
      open("back", { prompt: inBox }).release();
      const back = open("back", { prompt: { setup: OFF, full: "Host prompt." } });
      expect(lines(file).filter((l) => l.t === "system")).toHaveLength(2);
      expect(back.lines.map((l) => l.text)).toEqual(["Resumed: hi.", `${SANDBOX_CHANGED}.`]);
      expect(await sendAfter(back, OFF)).toEqual([]);
    });

    it("tells a conversation resumed a day later of the date", async () => {
      savedOn("later", OFF);
      const later = await sendAfter(open("later", { prompt: SAVED }), OFF, "2026-11-18");
      expect(later).toEqual(["This note is from Tachikoma, not the user: today's date is now 2026-11-18."]);
    });

    // System prompt plan, Task 8: /clear's prompt is built with that day's date, which its start line records, so the
    // new conversation's first request needs no date note.
    it("sends no date note after a /clear on a later day, the new prompt having the date", async () => {
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, SAVED);
      const fresh = w.fresh("fake:a", { system: "Fresh prompt of 2026-11-18.", date: "2026-11-18" });
      onTestFinished(fresh.release);
      expect(await sendAfter(fresh, OFF, "2026-11-18")).toEqual([]);
    });

    it("tells a conversation saved before this change of the date, and of the setup as far as known", async () => {
      const date = "This note is from Tachikoma, not the user: today's date is now 2026-11-17."; // never told
      saved(dir, "notedoff", chat({ ...start("notedoff"), box: false }));
      expect(await sendAfter(open("notedoff", { prompt: SAVED }), OFF)).toEqual([date]);
      saved(dir, "notedbox", chat({ ...start("notedbox"), box: true }));
      saved(dir, "notedhost", chat({ ...start("notedhost"), box: true }));
      const live: Setup = { sandbox: "live", network: "off", git: "none" };
      expect(await sendAfter(open("notedbox", { prompt: { setup: live, full: "Box prompt." } }), live)).toEqual([
        date,
        "This note is from Tachikoma, not the user: this session was resumed, its earlier sandbox setup was not " +
          "recorded, and the system prompt was replaced with one for this setup. The sandbox is now a live link to " +
          "the project. The project is not a git repository. Shell commands cannot reach the web now.",
      ]);
      expect(await sendAfter(open("notedhost", { prompt: { setup: OFF, full: "Host prompt." } }), OFF)).toEqual([
        date,
        "This note is from Tachikoma, not the user: this session was resumed under another setup, and the system " +
          "prompt was replaced with one for this setup. Commands now run with PowerShell in C:\\proj; earlier they " +
          "ran with bash in /work. The project is not a git repository. Shell commands can reach the web now. " +
          "Earlier replies about the setup were right under the system prompt they were made with.",
      ]);
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
    const again = systemAgain((date) => `The base of ${date}.`, where, asked);
    let text = (await again("2026-11-18")).system;
    expect(text.startsWith("The base of 2026-11-18.\n\n")).toBe(true);
    expect(text).toContain("second words");
    expect(text).toContain("allowed words");
    writeFileSync(path.join(root, "CLAUDE.md"), "third words\n@../outside/new.md\n");
    text = (await again("2026-11-18")).system;
    expect(text).toContain("third words");
    expect(text).not.toContain("new words");
    const all = systemAgain(() => "The base.", where, "all");
    expect((await all("2026-11-18")).system).toContain("new words"); // never mode reads them, as at launch
  });

  // Release 8e plan, step 15: the files read again come back beside the text, for InstructionsLoaded to be sent once the
  // text is the conversation's prompt; those left out are not among them.
  it("hands back the instruction files read again beside the prompt, those left out not among them", async () => {
    const own = mkdtempSync(path.join(tmpdir(), "tachi-clilib-instr-"));
    onTestFinished(() => removeTree(own));
    const [home, root, outside] = [path.join(own, "home"), path.join(own, "project"), path.join(own, "outside")];
    for (const d of [home, root, outside]) mkdirSync(d);
    writeFileSync(path.join(outside, "new.md"), "new words");
    writeFileSync(path.join(root, "a.md"), "a words");
    writeFileSync(path.join(root, "CLAUDE.md"), "@a.md @../outside/new.md\n");
    const where = { root, home, top: root };
    const claude = { path: path.join(root, "CLAUDE.md"), size: 25, type: "Project" };
    const a = { path: path.join(root, "a.md"), size: 7, type: "Project", parent: claude.path };
    expect((await systemAgain(() => "The base.", where, new Map())("2026-11-18")).files).toEqual([claude, a]);
    const all = await systemAgain(() => "The base.", where, "all")("2026-11-18");
    expect(all.files).toEqual([claude, a, { path: path.join(outside, "new.md"), size: 9, type: "Project", parent: claude.path }]);
  });

  describe("newSaved", () => {
    const begin = { project: "p", lead: "fake:a", version: "0.8.0", system: "New prompt.", tools };
    const recorded = { date: "2026-11-17", setup: OFF }; // system prompt plan, Task 6

    it("writes the start line and the name, then takes the lock", () => {
      const o = newSaved(dir, { ...begin, ...recorded, id: "fresh", print: true }, "my name");
      onTestFinished(o.release);
      expect(o.conversation).toMatchObject({ id: "fresh", system: "New prompt.", messages: [], prompts: [], calls: [], nextPicture: 1, nextTask: 1 });
      expect(o.conversation.told).toEqual(recorded);
      expect(o.conversation.transcript!.failed).toBeNull();
      const lines = read(path.join(dir, "fresh.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
      const first = { t: "start", v: 1, id: "fresh", lead: "fake:a", print: true, system: "New prompt.", box: false };
      expect(lines).toMatchObject([{ ...first, ...recorded, tools }, { t: "name", name: "my name" }]);
      expect(read(path.join(dir, "fresh.lock"))).toBe(String(process.pid));
    });

    // Release 8e plan, step 15: a new session always has the prompt just built, so the launch fires InstructionsLoaded.
    it("says a new session got the prompt just built", () => {
      const o = newSaved(dir, { ...begin, ...recorded, id: "fresh-built", print: true });
      onTestFinished(o.release);
      expect(o.built).toBe(true);
    });

    it("goes on unsaved, taking no lock, when a file stands where the sessions folder should be", () => {
      const blocked = path.join(folder(), "sessions");
      writeFileSync(blocked, "not a folder");
      const o = newSaved(blocked, { ...begin, ...recorded, id: "fresh", print: false });
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
      const next = w.fresh("fake:b", { system: "Fresh prompt.", date: "2026-11-18", setup: LIVE_ON });
      w.switched(next);
      expect(w.lost()).toEqual([]);
      expect(marked("w2")).toBe(false);
      const lock = openSession(dir, "w2"); // free for another window now
      expect(lock).not.toBeNull();
      lock!.release();
      expect(openSession(dir, next.conversation.id)).toBeNull(); // the new one's held
      // The fresh prompt's date and setup, not the window's (system prompt plan, Task 8).
      const fresh = { t: "start", project: top, lead: "fake:b", print: false, system: "Fresh prompt.", tools };
      const recorded = { date: "2026-11-18", setup: LIVE_ON, box: true };
      expect(lines(next.conversation.transcript!.file)).toMatchObject([{ ...fresh, ...recorded }]);
    });

    it("opens /resume's pick under the launch's sandbox setting and prompt, as the launch opens one", () => {
      const file = saved(dir, "w4", talk("w4", "one"));
      const boxed = { setup: LIVE_OFF, full: "Box prompt." };
      const w = new WindowSessions(dir, { project: top, version: "0.8.0", tools }, boxed);
      const next = w.resume("w4", (saved) => saved);
      if ("problem" in next) throw new Error(next.problem);
      onTestFinished(next.release);
      expect(next.conversation.system).toBe("Box prompt.");
      expect(lines(file).at(-1)).toMatchObject({ t: "system", system: "Box prompt.", box: true, setup: LIVE_OFF });
      const fresh = w.fresh("fake:a", { system: "Fresh prompt.", date: "2026-11-18" }); // no setup: the window's
      onTestFinished(fresh.release);
      const first = { t: "start", system: "Fresh prompt.", date: "2026-11-18", box: true, setup: LIVE_OFF };
      expect(lines(fresh.conversation.transcript!.file)[0]).toMatchObject(first);
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

// 8c-2b plan, Step 6: a sites launch, in-process, with a stand-in Docker that answers by each call (release 7 plan,
// choice 69): the network and proxy (Step 5), the box, today's node check, then the launch check (sitesNet.ts).
describe("a sites launch", () => {
  type Answer = Awaited<ReturnType<NonNullable<Parameters<typeof sandboxStart>[3]["run"]>>>;
  type Run = NonNullable<Parameters<typeof sandboxStart>[3]["run"]>;
  const ok = (out = ""): Answer => ({ code: 0, out, err: "" });
  const INFO = JSON.stringify({
    NCPU: 24, MemTotal: 33518923776, SecurityOptions: [], MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true,
  });
  const CHECK_OK = {
    fib_trie: "Main:\n  +-- 0.0.0.0/0 2 0 2\n     |-- 172.23.0.0\n        /16 link UNICAST\n" +
      "     |-- 172.23.0.1\n        /32 host LOCAL\nLocal:\n",
    ipv6_route:
      "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
      "00000000 00000004 00000000 80200001       lo\n",
    rules: { missing: true },
    direct: { error: "ENETUNREACH" },
    unlisted: { status: "HTTP/1.1 403 Tachikoma's sandbox refused x: not on the allowed sites" },
    tunnel: { status: "HTTP/1.1 200 Connection established", after: 0 },
    lookup: { error: "EAI_AGAIN" },
  };

  function stand(o: { node?: Answer; check?: Record<string, unknown>; rmFails?: boolean } = {}) {
    const calls: string[][] = [];
    let check = "";
    const run: Run = async (args, opts) => {
      calls.push(args);
      const [verb, sub] = args;
      if (verb === "ps" || (verb === "network" && sub === "ls")) return ok();
      if (verb === "info") return ok(`${INFO}\n`);
      if (verb === "network" && sub === "create") return ok("n3t\n");
      if (verb === "network" && sub === "inspect") return ok('[{"Subnet":"172.23.0.0/16"}]');
      if (verb === "run" && args.includes("/proxy/proxy.cjs")) {
        const folder = args[args.indexOf("-v") + 1]!.replace(/:\/proxy:ro$/, "");
        check = (JSON.parse(readFileSync(path.join(folder, "settings.json"), "utf8")) as { check: string }).check;
        return ok("pr0xy\n");
      }
      if (verb === "run") return ok("b0x\n");
      if (verb === "logs" && sub === "--follow") {
        opts?.line?.('{"port":40103,"udp":53,"tcp":53}');
        return new Promise<Answer>((_, reject) => {
          if (opts?.signal?.aborted) reject(new Error("stopped"));
          opts?.signal?.addEventListener("abort", () => reject(new Error("stopped")));
        });
      }
      if (verb === "logs") return ok(`{"lookup":"${check}"}\n`);
      if (verb === "inspect" && args[2]!.startsWith("{{(index")) return ok("172.23.0.2\n");
      if (verb === "inspect" && args[2] === "{{json .NetworkSettings.Networks}}") {
        const net = calls.find((c) => c[1] === "create")!.at(-1)!;
        return ok(`{"${net}":{"IPAddress":"172.23.0.1"}}`);
      }
      if (verb === "inspect") return ok("true\n"); // the box is running (executor.ts, a failed command's check)
      if (verb === "exec" && args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (verb === "exec" && args[1] === "-i") return ok(JSON.stringify({ ...CHECK_OK, ...o.check }));
      if (verb === "exec" && args[1] === "-w") {
        if (args.at(-1)!.startsWith("curl")) return { code: 6, out: "", err: "" };
        if (args.at(-1)!.startsWith("node -e")) return o.node ?? ok("v24.22.2 function");
        return ok();
      }
      if (o.rmFails && verb === "network" && sub === "rm") return { code: 1, out: "", err: "boom\n" };
      return ok();
    };
    return { run, calls };
  }

  async function launch(sites: { name: string; port: number }[], s = stand()) {
    const root = mkdtempSync(path.join(tmpdir(), "tachi-sites-launch-"));
    onTestFinished(() => removeTree(root));
    const tag = "tachikoma-sandbox:0123456789ab";
    const ready: Ready = { tag, git: undefined, mounts: [], env: {}, gitOutside: false };
    const lines: string[] = [];
    const io = { err: (l: string) => lines.push(l), run: s.run };
    const waits = { setup: 1000, check: 1000 }; // the test's own limits
    const opts = { network: "sites" as const, sites, limits: undefined, session: "s1", waits };
    const started = await sandboxStart(root, ready, opts, io);
    if (!("exit" in started)) onTestFinished(() => started.box.stop());
    return { root, lines, started, calls: s.calls };
  }
  const removals = (calls: string[][]) => calls.filter((c) => c[0] === "rm" || (c[0] === "network" && c[1] === "rm"));
  const SITES = [{ name: "github.com", port: 443 }, { name: "pypi.org", port: 443 }];

  it("the launch line says network sites (2)", async () => {
    const r = await launch(SITES);
    if ("exit" in r.started) throw new Error(r.lines.join("\n"));
    expect(r.started.lines[0]).toBe(
      `Sandbox: live link on ${r.root}, network sites (2), limits 4g, 4 CPUs, 1024 processes.`,
    );
    expect(r.started.lines).not.toContain(
      'The sandbox\'s network allows no sites; add them to "allowedSites" in ~/.tachikoma/settings.json.',
    );
    // The order of decision 10: the network and proxy, the box, the node check, then the launch check.
    const order = r.calls.map((c) => c.slice(0, 2).join(" "));
    const at = (what: string) => order.findIndex((c) => c.startsWith(what));
    expect(at("network create")).toBeLessThan(at("run -d"));
    expect(at("exec -w")).toBeLessThan(at("network inspect"));
    expect(at("network inspect")).toBeLessThan(at("exec -i"));
  });

  it("with no site it says (0) and line 2", async () => {
    const r = await launch([]);
    if ("exit" in r.started) throw new Error(r.lines.join("\n"));
    expect(r.started.lines[0]).toContain("network sites (0)");
    expect(r.started.lines).toContain(
      'The sandbox\'s network allows no sites; add them to "allowedSites" in ~/.tachikoma/settings.json.',
    );
  });

  it("a failed check ends with line 8, and the box, the proxy and the network are removed", async () => {
    const r = await launch(SITES, stand({ check: { direct: { connected: true } } }));
    expect(r.started).toEqual({ exit: 1 });
    expect(r.lines).toEqual([
      "The sandbox's allowed sites cannot be held on this machine: the box connected straight to an outside address. " +
        "Use --network off or --network on.",
    ]);
    const net = r.calls.find((c) => c[1] === "create")!.at(-1)!;
    const proxy = r.calls.find((c) => c.includes("/proxy/proxy.cjs"))![6]!;
    expect(removals(r.calls)).toEqual([["rm", "-f", "b0x"], ["rm", "-f", proxy], ["network", "rm", net]]);
  });

  it("a removal that fails is named after the launch's line (W15), and the launch still ends", async () => {
    const r = await launch(SITES, stand({ check: { direct: { connected: true } }, rmFails: true }));
    expect(r.started).toEqual({ exit: 1 });
    const net = r.calls.find((c) => c[1] === "create")!.at(-1)!;
    expect(r.lines[1]).toBe(`Left in Docker: ${net}. The next launch removes them.`);
  });

  it("the node check still comes first and keeps its own lines, with everything removed", async () => {
    const missing = { code: 127, out: "", err: "bash: line 1: node: command not found\n" };
    const r = await launch(SITES, stand({ node: missing }));
    expect(r.started).toEqual({ exit: 1 });
    expect(r.lines).toEqual(["The sandbox's image has no node, which Tachikoma's file tools need in the box."]);
    expect(r.calls.some((c) => c[0] === "network" && c[1] === "inspect")).toBe(false);
    expect(removals(r.calls)).toHaveLength(3);
  });

  it("a Docker answer the check cannot take still removes everything (the step's review)", async () => {
    const s = stand();
    const odd = (args: string[]) => (s.calls.push(args), Promise.resolve(ok("[null]")));
    const run: Run = (args, opts) => (args[0] === "network" && args[1] === "inspect" ? odd(args) : s.run(args, opts));
    const r = await launch(SITES, { run, calls: s.calls });
    expect(r.started).toEqual({ exit: 1 });
    expect(r.lines[0]).toMatch(/^The sandbox's allowed sites cannot be held on this machine: the check could not run/);
    expect(removals(r.calls)).toHaveLength(3);
  });

  it("a check that never finishes ends at the check limit, with everything removed", async () => {
    const s = stand();
    const hang = (signal?: AbortSignal) =>
      new Promise<Answer>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped"))));
    const run: Run = (args, opts) =>
      args[0] === "exec" && args[1] === "-i" ? (s.calls.push(args), hang(opts?.signal)) : s.run(args, opts);
    const r = await launch(SITES, { run, calls: s.calls });
    expect(r.lines[0]).toBe(
      "The sandbox's allowed sites cannot be held on this machine: the check did not finish within 1 s. " +
        "Use --network off or --network on.",
    );
    expect(removals(r.calls)).toHaveLength(3);
  });

  it("a failed command in a sites box gets line 6, through exec and through start's log", async () => {
    const r = await launch(SITES);
    if ("exit" in r.started) throw new Error(r.lines.join("\n"));
    expect(SITES_NOTE).toBe(
      '(The sandbox\'s network reaches only its allowed sites; the user can add one to "allowedSites".)',
    );
    const failed = await r.started.executor.exec("curl https://example.com", "/work");
    expect(failed.stderr).toBe(SITES_NOTE);
    const running = r.started.executor.start("curl https://example.com", "/work");
    await running.done;
    expect(running.log.kept()).toBe(SITES_NOTE);
    const fine = await r.started.executor.exec("echo ok", "/work");
    expect(fine.stderr).toBe("");
  });
});
