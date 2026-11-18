import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { running } from "../../src/exec/local.js";
import type { ServerConfig, ServerEntry } from "../../src/mcp/config.js";
import { type CheckedFetch, connectionFetch, NotReached, Server } from "../../src/mcp/server.js";
import { sitesFetch } from "../../src/mcp/sitesFetch.js";
import type { Site } from "../../src/sandbox/sites.js";
import { removeTree } from "../helpers.js";
import { type FakeOptions, fakeHelper, fakeServer, httpFake, readLog } from "./fake.js";

// Release 8c plan, Task 4: one server's connection, local or remote, against the fake servers of fake.ts.

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const windows = process.platform === "win32";

const base: Omit<ServerConfig, "entry" | "asWritten"> = {
  name: "fake", safe: "fake", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
};
const local = (args: string[], over: Partial<Extract<ServerEntry, { kind: "stdio" }>> = {}): ServerConfig => ({
  ...base,
  entry: { kind: "stdio", command: process.execPath, args, env: {}, ...over },
  asWritten: { command: process.execPath, args },
});
const remote = (url: string, headers: Record<string, string> = {}, headersHelper?: string): ServerConfig => ({
  ...base,
  entry: { kind: "http", url, headers, ...(headersHelper !== undefined && { headersHelper }) },
  asWritten: { url, headers },
});

// The test's own folder, the project's root, and its servers, each stopped before the folder is removed: on Windows a
// running server holds the folder it works in.
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-server-"));
  const servers: Server[] = [];
  onTestFinished(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await removeTree(dir);
  });
  const onChange = vi.fn();
  const make = (
    config: ServerConfig,
    opts: {
      env?: NodeJS.ProcessEnv; startMs?: number; root?: string; helper?: { cwd: string; project: boolean };
      checked?: CheckedFetch;
    } = {},
  ) => {
    const server = new Server(config, {
      root: opts.root ?? dir, env: opts.env ?? process.env, onChange, startMs: opts.startMs, helper: opts.helper,
      ...(opts.checked && { checked: opts.checked }),
    });
    servers.push(server);
    return server;
  };
  const log = path.join(dir, "log.jsonl");
  const script = (opts: FakeOptions = {}) => fakeServer(dir, { log, ...opts });
  return { dir, make, onChange, log, script };
}

const textOf = (result: { content: unknown }) => (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
const names = (server: Server) => (server.state.is === "ready" ? server.state.tools.map((t) => t.name) : server.state);
const TOOLS = [
  "echo", "error", "picture", "structured", "slow", "progress", "whoami", "ask", "change", "exit", "write",
];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
const pidIn = (file: string) => Number(readFileSync(file, "utf8"));
// A wait on another process: a few seconds for a busy machine, well inside the test's 15 s.
const WAIT = { timeout: 5_000 };

describe("a local server", () => {
  it("starts, lists its tools, answers a call, and is told Tachikoma's name, roots and elicitation, never sampling", async () => {
    const { dir, make, log, script } = await setup();
    const server = make(local([await script()]));
    expect(server.state).toEqual({ is: "starting" });
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(server.connection).toBe(1);
    expect(textOf(await server.callTool("echo", { text: "hello" }, {}))).toBe("hello");
    const init = readLog(log).find((m) => m.method === "initialize")!;
    expect(init.params.clientInfo).toEqual({ name: "tachikoma", version: VERSION });
    expect(init.params.capabilities).toEqual({ roots: {}, elicitation: { form: {}, url: {} } });
    // The roots are the project's folder (design, "The folder a server is told it works in"); a Server given no form
    // handler declines a form (Task 12's forms are tests/mcp/forms.test.ts's).
    const roots = await server.callTool("ask", { method: "roots/list" }, {});
    expect(JSON.parse(textOf(roots))).toEqual({ roots: [{ uri: pathToFileURL(dir).href }] });
    const form = { mode: "form", message: "Your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } } } };
    expect(JSON.parse(textOf(await server.callTool("ask", { method: "elicitation/create", params: form }, {})))).toEqual({ action: "decline" });
  });

  it("works in the project's folder, with CLAUDE_PROJECT_DIR, the entry's env and its args, and without Tachikoma's keys", async () => {
    const { dir, make, script } = await setup();
    const env = { ...process.env, ANTHROPIC_API_KEY: "sk-test-not-a-key" };
    const server = make(local([await script(), "--flag", "two words"], { env: { MINE: "from the entry" } }), { env });
    await server.start();
    const seen = JSON.parse(textOf(await server.callTool("whoami", {}, {})));
    expect(seen).toEqual({ argv: ["--flag", "two words"], cwd: dir, project: dir, mine: "from the entry", key: null });
  });

  it.skipIf(!windows)("starts a .cmd by its full path, in a folder with a space, its argument arriving whole", async () => {
    const { dir, make, script } = await setup();
    const folder = path.join(dir, "with space");
    await mkdir(folder);
    const fake = await script();
    await writeFile(path.join(folder, "x.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
    // %PATH% is a variable cmd.exe would fill in, had the argument not been escaped.
    const arg = "a b & c ^ d % e %PATH%";
    const env = { ...process.env, PATH: `${folder};${process.env.PATH}` };
    const server = make(local([arg], { command: "x" }), { env });
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(JSON.parse(textOf(await server.callTool("whoami", {}, {}))).argv).toEqual([arg]);
  });

  it("fails at once when its program is not on PATH", async () => {
    const { dir, make } = await setup();
    const server = make(local([], { command: "tachi-no-such-server" }), { env: { PATH: dir } });
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "tachi-no-such-server was not found on PATH" });
  });

  it("fails with the system's words when its program cannot start", async () => {
    const { dir, make, script } = await setup();
    const server = make(local([await script()]), { root: path.join(dir, "missing") });
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: `${process.execPath} could not start (spawn ${process.execPath} ENOENT)` });
  });

  it("fails at its start limit when it never answers, and its process is gone", async () => {
    const { dir, make, script } = await setup();
    const pidFile = path.join(dir, "pid");
    const server = make(local([await script({ silent: true, pidFile })]), { startMs: 1_000 });
    const began = Date.now();
    await server.start();
    expect(Date.now() - began).toBeGreaterThanOrEqual(1_000);
    expect(server.state).toEqual({ is: "failed", reason: "it did not answer within 1 s" });
    await vi.waitFor(() => expect(alive(pidIn(pidFile))).toBe(false), WAIT);
  });

  it("fails with its exit code and the last line of its error output, escaped", async () => {
    const { make, script } = await setup();
    const stderr = `starting\nlast words ${String.fromCharCode(27)}[31m\r\n\n  \n`;
    const server = make(local([await script({ exit: 3, stderr })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it exited with code 3: last words \\u001b[31m" });
  });

  // Choice 5: Node ends an uncaught error with its stack and its version, which are passed over (Task 4's review).
  it("gives a crashed Node server's error, not Node's closing lines", async () => {
    const { make, script } = await setup();
    const server = make(local([await script({ crash: "GITHUB_TOKEN is not set" })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it exited with code 1: Error: GITHUB_TOKEN is not set" });
  });

  // Node prints a system error's fields (errno, code, syscall, path) in a block after its stack.
  it("gives a crashed Node server's error, not the block of its fields", async () => {
    const { dir, make, script } = await setup();
    const server = make(local([await script({ start: 'require("node:fs").readFileSync("no-such-config.json")' })]));
    await server.start();
    const open = `Error: ENOENT: no such file or directory, open '${path.join(dir, "no-such-config.json")}'`;
    expect(server.state).toEqual({ is: "failed", reason: `it exited with code 1: ${open}` });
  });

  // The cause is printed inside the block, with a stack and a block of its own, and the outer stack holds Node's
  // "... N lines matching cause stack trace ..." line.
  it("gives the outer error of a crash with a cause", async () => {
    const { make, script } = await setup();
    const start = 'throw new Error("outer", { cause: Object.assign(new Error("inner"), { code: "E_INNER" }) })';
    const server = make(local([await script({ start })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it exited with code 1: Error: outer" });
  });

  it("gives the error a server logged with console.error before it exited", async () => {
    const { dir, make, script } = await setup();
    const start = 'try { require("node:fs").readFileSync("no-such-config.json") } catch (err) { console.error(err); process.exit(1) }';
    const server = make(local([await script({ start })]));
    await server.start();
    const open = `Error: ENOENT: no such file or directory, open '${path.join(dir, "no-such-config.json")}'`;
    expect(server.state).toEqual({ is: "failed", reason: `it exited with code 1: ${open}` });
  });

  it("ends at the exit code when nothing but Node's closing lines is left", async () => {
    const { make, script } = await setup();
    const stack = ["at main (server.js:1:1)", "at Array.map (<anonymous>)", "at Promise.all (index 0)", "at JSON.parse (native)"];
    const server = make(local([await script({ exit: 3, stderr: `${stack.map((l) => `    ${l}\n`).join("")}\nNode.js v22.20.0\n` })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it exited with code 3" });
  });

  it("keeps a last line that starts with at but is not a stack line", async () => {
    const { make, script } = await setup();
    const server = make(local([await script({ exit: 2, stderr: "at least one of FOO or BAR must be set\n" })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it exited with code 2: at least one of FOO or BAR must be set" });
  });

  it.skipIf(windows)("fails with the signal that ended it", async () => {
    const { make, script } = await setup();
    const server = make(local([await script({ signal: "SIGTERM" })]));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it was ended by signal SIGTERM" });
  });

  it("is stopped when it exits once ready, its exit code without error output the reason, and onChange is called", async () => {
    const { make, onChange, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    await expect(server.callTool("exit", { code: 3 }, {})).rejects.toThrow();
    await vi.waitFor(() => expect(server.state).toEqual({ is: "stopped", reason: "it exited with code 3", retry: false }), WAIT);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps a description longer than 4,096 characters whole", async () => {
    const { make, script } = await setup();
    const description = "d".repeat(5_000);
    const server = make(local([await script({ description })]));
    await server.start();
    expect(server.state.is === "ready" && server.state.tools[0]!.description).toBe(description);
  });

  it("ends a call at its entry's timeout, though the server keeps sending progress", async () => {
    const { make, log, script } = await setup();
    // Built here, not read: readServers ignores a timeout below 1,000 ms, as Claude Code does.
    const server = make(local([await script()], { timeout: 300 }));
    await server.start();
    // "Request timed out" is the library's own limit firing; the progress sent before it did not put it off.
    await expect(server.callTool("progress", {}, {})).rejects.toThrow("Request timed out");
    expect(readLog(log).some((m) => m.sent?.method === "notifications/progress")).toBe(true);
  });

  it("stops a call when its signal is aborted, and tells the server", async () => {
    const { make, log, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    const stop = new AbortController();
    const call = server.callTool("slow", {}, { signal: stop.signal });
    await vi.waitFor(() => expect(readLog(log).some((m) => m.method === "tools/call")).toBe(true), WAIT);
    stop.abort();
    await expect(call).rejects.toThrow();
    const id = readLog(log).find((m) => m.method === "tools/call")!.id;
    await vi.waitFor(() => expect(readLog(log).find((m) => m.method === "notifications/cancelled")?.params.requestId).toBe(id), WAIT);
  });

  // Task 5's code review: for a format it does not know, the library's checker warns on the console with the server's own
  // text, which would reach the terminal raw. The Client checks a tool's outputSchema at its first call (2.4.0's
  // callTool), whatever the answer.
  it("calls a tool whose outputSchema has a format the checker does not know, with nothing on the console", async () => {
    const { make, script } = await setup();
    const warn = vi.spyOn(console, "warn");
    onTestFinished(() => warn.mockRestore());
    const outputSchema = { type: "object", properties: { file: { type: "string", format: "path" } } };
    const server = make(local([await script({ tools: [{ name: "echo", inputSchema: { type: "object" }, outputSchema }] })]));
    await server.start();
    expect(names(server)).toEqual(["echo"]);
    await server.callTool("echo", { text: "x" }, {}).catch(() => {}); // no structured answer, which the library may refuse
    expect(warn).not.toHaveBeenCalled();
    expect(console.warn).toBe(warn);
  });

  it("takes a changed list of tools, and calls onChange", async () => {
    const { make, onChange, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    await server.callTool("change", {}, {});
    // The library waits 300 ms for more changes before it reads the list again (its debounceMs).
    await vi.waitFor(() => expect(names(server)).toEqual([...TOOLS, "added"]), WAIT);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(server.connection).toBe(1);
  });

  // Task 13: the resources `@` lists and the prompts the `/` menu lists, read at the start and when the server says they
  // changed; a read, and a prompt with its arguments.
  const NOTE = { uri: "note://a", name: "a note", text: "the note's text" };
  const GREET = {
    name: "greet",
    description: "Greets someone",
    arguments: [{ name: "name", required: true }],
    messages: [{ role: "user", content: { type: "text", text: "Say hello to {name}." } }],
  };

  it("lists its resources and prompts at the start, reads a resource, and gets a prompt with its arguments", async () => {
    const { make, log, script } = await setup();
    const server = make(local([await script({ resources: [NOTE], prompts: [GREET] })]));
    expect([server.resources, server.prompts]).toEqual([[], []]); // nothing until it is ready
    await server.start();
    await server.listed;
    expect(server.resources).toEqual([{ uri: "note://a", name: "a note" }]);
    expect(server.prompts).toEqual([{ name: "greet", description: "Greets someone", arguments: [{ name: "name", required: true }] }]);
    expect((await server.readResource("note://a", {})).contents).toEqual([{ uri: "note://a", text: "the note's text" }]);
    expect((await server.getPrompt("greet", { name: "Ann" }, {})).messages).toEqual([{ role: "user", content: { type: "text", text: "Say hello to Ann." } }]);
    expect(readLog(log).find((m) => m.method === "prompts/get")!.params.arguments).toEqual({ name: "Ann" });
  });

  // The library prints a console.debug line for each list asked of a server that does not offer it, which would land on
  // the window (the fix round's quality review).
  it("reads a server without resources or prompts as having none, asking it for neither, with nothing on the console", async () => {
    const { make, log, script } = await setup();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    onTestFinished(() => debug.mockRestore());
    const server = make(local([await script()]));
    await server.start();
    await server.listed;
    expect([server.resources, server.prompts]).toEqual([[], []]);
    expect(readLog(log).map((m) => m.method).filter((m) => /^(resources|prompts)\//.test(m ?? ""))).toEqual([]);
    expect(debug).not.toHaveBeenCalled();
  });

  // The fix round: a list that never answers, or fails, neither holds nor fails the start; the tools are there at once.
  it.each(["never", "error"] as const)("starts at once when its lists are answered %s, with none of them", async (lists) => {
    const { make, script } = await setup();
    const server = make(local([await script({ resources: [NOTE], prompts: [GREET], lists })]), { startMs: 2_000 });
    const began = Date.now();
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect([server.resources, server.prompts]).toEqual([[], []]);
  });

  it("fails a read the server answers with an error, with its words", async () => {
    const { make, script } = await setup();
    const server = make(local([await script({ resources: [{ ...NOTE, fails: "it is gone" }] })]));
    await server.start();
    await expect(server.readResource("note://a", {})).rejects.toThrow("it is gone");
  });

  it("takes a changed list of resources, and calls onChange", async () => {
    const { make, onChange, script } = await setup();
    const server = make(local([await script({ resources: [NOTE] })]));
    await server.start();
    await server.listed;
    onChange.mockClear(); // a list that answers after the start calls it too
    await server.callTool("add-resource", { resource: { uri: "note://b", name: "b" } }, {});
    await vi.waitFor(() => expect(server.resources.map((r) => r.uri)).toEqual(["note://a", "note://b"]), WAIT);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stop kills a server that ignores its closed input, and on Windows its child too", async () => {
    const { dir, make, onChange, script } = await setup();
    const pidFile = path.join(dir, "pid");
    const childPidFile = path.join(dir, "child-pid");
    const server = make(local([await script({ stubborn: true, pidFile, childPidFile })]));
    await server.start();
    const pid = pidIn(pidFile);
    const child = pidIn(childPidFile);
    if (!windows) onTestFinished(() => void (alive(child) && process.kill(child))); // its children are a known limit (choice 3)
    // It joins the kill at Tachikoma's exit, so a crash stops it too (choice 3).
    expect([...running].some((c) => c.pid === pid)).toBe(true);
    await server.stop();
    await vi.waitFor(() => expect(alive(pid)).toBe(false), WAIT);
    if (windows) await vi.waitFor(() => expect(alive(child)).toBe(false), WAIT);
    expect([...running].some((c) => c.pid === pid)).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("a remote server", () => {
  it("starts and lists over HTTP, the entry's headers sent with each request", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const server = make(remote(fake.url, { "X-Test": "yes" }));
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(textOf(await server.callTool("echo", { text: "over HTTP" }, {}))).toBe("over HTTP");
    const posts = readLog(log).filter((m) => m.http === "POST");
    expect(posts.map((m) => m.body.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(posts.every((m) => m.headers["x-test"] === "yes")).toBe(true);
  });

  it("fails with its address and the status it answered, the address's path and query left out", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir, { status: 503 });
    // A filled-in ${VAR} can put a key in the path or the query.
    const server = make(remote(`${fake.url}?key=secret`));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: `http://127.0.0.1:${fake.port} answered 503` });
  });

  it("fails at its start limit when it never answers", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir, { silent: true });
    const server = make(remote(fake.url), { startMs: 1_000 });
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "it did not answer within 1 s" });
  });

  it("is stopped with retry at each drop and reconnects each time, until a reconnect fails, after which none is tried", async () => {
    const { dir, make, onChange, log } = await setup();
    const first = await httpFake(dir, { log });
    const server = make(remote(first.url));
    await server.start();
    expect(server.connection).toBe(1);
    const refused = `connect ECONNREFUSED 127.0.0.1:${first.port}`;

    // Gone: the call's request is refused, so it never reached the server (choice 13).
    await first.stop();
    const call = server.callTool("echo", { text: "x" }, {});
    await expect(call).rejects.toThrow(NotReached);
    await expect(call).rejects.toThrow(refused);
    expect(server.state).toEqual({ is: "stopped", reason: refused, retry: true });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Back on the same port: one new connection.
    const second = await httpFake(dir, { log, port: first.port });
    expect(await server.reconnect()).toBe(true);
    expect(names(server)).toEqual(TOOLS);
    expect(server.connection).toBe(2);
    expect(textOf(await server.callTool("echo", { text: "again" }, {}))).toBe("again");

    // Restarted, it no longer knows the session (404), so this call never reached it either; this drop gets its own
    // new connection.
    await second.stop();
    const third = await httpFake(dir, { log, port: first.port });
    await expect(server.callTool("echo", { text: "x" }, {})).rejects.toThrow(NotReached);
    expect(server.state).toEqual({ is: "stopped", reason: `http://127.0.0.1:${first.port} answered 404`, retry: true });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(await server.reconnect()).toBe(true);
    expect(server.connection).toBe(3);

    // Gone again, and not back: the reconnect fails, and no other is tried.
    await third.stop();
    await expect(server.callTool("echo", { text: "x" }, {})).rejects.toThrow(NotReached);
    expect(server.state).toEqual({ is: "stopped", reason: refused, retry: true });
    expect(await server.reconnect()).toBe(false);
    expect(server.state).toEqual({ is: "stopped", reason: refused, retry: false });
    expect(server.connection).toBe(4);
    const initializes = () => readLog(log).filter((m) => m.body?.method === "initialize").length;
    const before = initializes();
    expect(await server.reconnect()).toBe(false);
    expect(initializes()).toBe(before);
    expect(server.connection).toBe(4);
  });

  // The fix round: a read whose request never reached a remote server throws NotReached, with the reason a call's has,
  // for the caller to connect again and read once more.
  it("throws NotReached for a read the server never got, with its reason, and is stopped with retry", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir, { resources: [{ uri: "note://a", name: "a", text: "hi" }] });
    const server = make(remote(fake.url));
    await server.start();
    await fake.stop();
    const read = server.readResource("note://a", {});
    await expect(read).rejects.toThrow(NotReached);
    await expect(read).rejects.toThrow(`connect ECONNREFUSED 127.0.0.1:${fake.port}`);
    expect(server.state).toMatchObject({ is: "stopped", retry: true });
  });

  it("gives two reconnects at once the same new connection and the same answer", async () => {
    const { dir, make, log } = await setup();
    const first = await httpFake(dir, { log });
    const server = make(remote(first.url));
    await server.start();
    await first.stop();
    await expect(server.callTool("echo", { text: "x" }, {})).rejects.toThrow(NotReached);
    await httpFake(dir, { log, port: first.port });
    const initializes = () => readLog(log).filter((m) => m.body?.method === "initialize").length;
    const before = initializes();
    expect(await Promise.all([server.reconnect(), server.reconnect()])).toEqual([true, true]);
    expect(initializes()).toBe(before + 1);
    expect(server.connection).toBe(2);
    // Once it is done, the next caller is answered for the state it left: ready, so nothing to reconnect.
    expect(await server.reconnect()).toBe(false);
  });

  it("fails a call cut off after it reached the server with the library's error, not NotReached, and is stopped with retry", async () => {
    const { dir, make, onChange } = await setup();
    const fake = await httpFake(dir);
    const server = make(remote(fake.url));
    await server.start();
    const call = server.callTool("cut", {}, {});
    await expect(call).rejects.toThrow();
    await expect(call).rejects.not.toBeInstanceOf(NotReached);
    expect(server.state.is === "stopped" && server.state.retry).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

// 8c-2a plan, Task 10 (decisions 14, 17, 22, 27 and 28; choices 1 (b) and 5): the headersHelper at each connection, and
// no redirect to another origin with the entry's headers.
// 8c-2b plan, Step 9 (decisions 13 and 13a; design, section 3): a remote server with the allowed sites in force, each
// connection's requests through its own checked fetch (Step 8), whose lookup answers `table` (a public address
// otherwise) and whose connection goes to the fake on 127.0.0.1 at the port asked for (decision 12).
describe("a remote server with the allowed sites", () => {
  const PUBLIC = "93.184.215.14";
  const checking = (sites: Site[], table: Record<string, string[]> = {}) => {
    const lookups: string[] = [];
    const checked: CheckedFetch = (refused) =>
      sitesFetch({
        sites, own: [], refused,
        lookup: async (name) => (lookups.push(name), table[name] ?? [PUBLIC]),
        connect: (_address, port) => net.connect(port, "127.0.0.1"),
      });
    return { checked, lookups, table };
  };
  const named = (port: number, path = "/mcp") => `http://mcp.example:${port}${path}`;
  const listed = (port: number) => [{ name: "mcp.example", port }];

  it("connects over HTTP when listed and calls a tool, each request looked up", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const c = checking(listed(fake.port));
    const server = make(remote(named(fake.port)), { checked: c.checked });
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(textOf(await server.callTool("echo", { text: "checked" }, {}))).toBe("checked");
    const posts = readLog(log).filter((m) => m.http === "POST").length;
    expect(c.lookups.length).toBeGreaterThanOrEqual(posts);
    expect(new Set(c.lookups)).toEqual(new Set(["mcp.example"]));
  });

  // A server of the old SSE transport, written here: its event stream names where messages go, and each answer comes
  // on the stream.
  it("connects over SSE when listed and calls a tool", async () => {
    let stream: http.ServerResponse | undefined;
    const sse = http.createServer((req, res) => {
      if (req.method === "GET") {
        stream = res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.write("event: endpoint\ndata: /messages\n\n");
      }
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(202).end();
        const m = JSON.parse(body);
        if (m.id === undefined) return;
        const info = { capabilities: { tools: {} }, serverInfo: { name: "sse", version: "1" } };
        const result =
          m.method === "initialize"
            ? { protocolVersion: m.params.protocolVersion, ...info }
            : m.method === "tools/list"
              ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "over SSE" }] };
        stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => sse.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => (sse.closeAllConnections(), void sse.close()));
    const port = (sse.address() as AddressInfo).port;
    const { make } = await setup();
    const url = named(port, "/sse");
    const c = checking(listed(port));
    const server = make({ ...base, entry: { kind: "sse", url, headers: {} }, asWritten: { url, headers: {} } }, c);
    await server.start();
    expect(names(server)).toEqual(["echo"]);
    expect(textOf(await server.callTool("echo", {}, {}))).toBe("over SSE");
    expect(new Set(c.lookups)).toEqual(new Set(["mcp.example"]));
  });

  it("fails with W5 when its listed name points somewhere local, sending it nothing", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const server = make(remote(named(fake.port)), checking(listed(fake.port), { "mcp.example": ["10.0.0.5"] }));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: `mcp.example:${fake.port} points at a local address` });
    expect(readLog(log)).toEqual([]);
  });

  it("follows a redirect within its origin, each hop checked, and fails one to an unlisted site", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log, slash: true });
    const c = checking(listed(fake.port));
    const server = make(remote(named(fake.port), { "X-Key": "static" }), c);
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    const posts = readLog(log).filter((m) => m.http === "POST");
    expect(new Set(posts.map((m) => m.path))).toEqual(new Set(["/mcp", "/mcp/"]));
    expect(c.lookups.length).toBeGreaterThanOrEqual(posts.length);
    // To another site: part A's rule, with the entry's headers, or the library's own same-site rule, without them,
    // stops it before the checked fetch is asked; either way the unlisted site is never looked up nor reached.
    const away = await httpFake(dir, { redirect: `http://evil.example:${fake.port}/mcp` });
    const a = checking(listed(away.port));
    const moved = make(remote(named(away.port), { "X-Key": "static" }), a);
    await moved.start();
    expect(moved.state).toEqual({
      is: "failed",
      reason:
        `the server answered with a redirect to http://evil.example:${fake.port}; ` +
        "Tachikoma does not follow a redirect with the entry's headers",
    });
    const b = checking(listed(away.port));
    const bare = make(remote(named(away.port)), b);
    await bare.start();
    expect(bare.state).toEqual({ is: "failed", reason: `http://mcp.example:${away.port} answered 307` });
    expect([...a.lookups, ...b.lookups].filter((n) => n !== "mcp.example")).toEqual([]);
  });

  it("is stopped with retry at a drop, as today, through the checked fetch", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir);
    const server = make(remote(named(fake.port)), checking(listed(fake.port)));
    await server.start();
    await fake.stop();
    const call = server.callTool("echo", { text: "x" }, {});
    await expect(call).rejects.toThrow(NotReached);
    await expect(call).rejects.toThrow(`connect ECONNREFUSED 127.0.0.1:${fake.port}`);
    expect(server.state).toMatchObject({ is: "stopped", retry: true });
  });

  // The step's code review: a refusal on a ready connection ends it, as every later request would be refused.
  it("fails a ready server with W5 when its name later points somewhere local, the call told the same", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir);
    const c = checking(listed(fake.port));
    const server = make(remote(named(fake.port)), c);
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    c.table["mcp.example"] = ["192.168.1.5"];
    const local = `mcp.example:${fake.port} points at a local address`;
    await expect(server.callTool("echo", { text: "x" }, {})).rejects.toThrow(local);
    expect(server.state).toEqual({ is: "failed", reason: local });
  });

  it("starts clean at a new connection after a refusal", async () => {
    const { dir, make } = await setup();
    const fake = await httpFake(dir);
    const c = checking(listed(fake.port), { "mcp.example": ["127.0.0.1"] });
    const server = make(remote(named(fake.port)), c);
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: `mcp.example:${fake.port} points at a local address` });
    c.table["mcp.example"] = [PUBLIC];
    await server.stop();
    await server.start(); // /mcp's Reconnect stops the server and starts it again
    expect(names(server)).toEqual(TOOLS);
  });

  // The user's decision after Step 8 (2026-11-18): a compressed answer fails its own request, here the first.
  it("fails with W14 when the server answers compressed", async () => {
    const gz = http.createServer((_req, res) => res.writeHead(200, { "content-encoding": "gzip" }).end("x"));
    await new Promise<void>((resolve) => gz.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => void gz.close());
    const port = (gz.address() as AddressInfo).port;
    const { make } = await setup();
    const server = make(remote(named(port)), checking(listed(port)));
    await server.start();
    const w14 =
      "the server sent a compressed answer (gzip), which Tachikoma does not read with the allowed sites in force";
    expect(server.state).toEqual({ is: "failed", reason: w14 });
  });
});

describe("a remote server's headersHelper, and its redirects", () => {
  const posts = (log: string) => readLog(log).filter((m) => m.http === "POST");
  const keys = (sent: Record<string, any>[]) =>
    new Set(sent.map((m) => `${m.headers["x-key"]} ${m.headers["x-other"]}`));
  const redirected = (origin: string) =>
    `the server answered with a redirect to ${origin}; Tachikoma does not follow a redirect with the entry's headers`;
  // A fake of its own logging to `log`, whose own address (its origin) the other fakes redirect to.
  const elsewhere = async (dir: string) => {
    const log = path.join(dir, "elsewhere.jsonl");
    const fake = await httpFake(dir, { log });
    return { log, origin: `http://127.0.0.1:${fake.port}` };
  };

  it("runs the helper at each connection, its x-key over the static X-Key, the other static header kept", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const helper = fakeHelper(dir);
    helper.give({ "x-key": "first" });
    const config = remote(fake.url, { "X-Key": "static", "X-Other": "kept" }, helper.command);
    const server = make(config, { helper: { cwd: dir, project: false } });
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    const first = posts(log);
    expect(first.length).toBeGreaterThan(0);
    expect(keys(first)).toEqual(new Set(["first kept"]));
    helper.give({ "x-key": "second" });
    await server.stop();
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    const second = posts(log).slice(first.length);
    expect(second.length).toBeGreaterThan(0);
    expect(keys(second)).toEqual(new Set(["second kept"]));
    expect(helper.runs()).toHaveLength(2);
  });

  it("fails when its helper fails, saying its exit code alone, and sends the server nothing", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const helper = fakeHelper(dir);
    helper.mode("fail");
    const server = make(remote(fake.url, {}, helper.command), { helper: { cwd: dir, project: false } });
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: "its headersHelper failed: it exited with code 3" });
    expect(readLog(log)).toEqual([]);
  });

  it("connects with its static headers when its helper is not run, which then records no run", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const helper = fakeHelper(dir);
    const server = make(remote(fake.url, { "X-Key": "static" }, helper.command));
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(new Set(posts(log).map((m) => m.headers["x-key"]))).toEqual(new Set(["static"]));
    expect(helper.runs()).toEqual([]);
  });

  // The path and query of the address it names are left out, as either may hold a key (decision 28).
  it("fails on a redirect to another origin, with static headers or the helper's, naming its origin", async () => {
    const { dir, make } = await setup();
    const other = await elsewhere(dir);
    const fake = await httpFake(dir, { redirect: `${other.origin}/key-in-path/mcp?token=key-in-query` });
    const helper = fakeHelper(dir);
    helper.give({ "x-key": "from the helper" });
    const servers = [
      make(remote(fake.url, { "X-Key": "static" })),
      make(remote(fake.url, {}, helper.command), { helper: { cwd: dir, project: false } }),
    ];
    for (const server of servers) {
      await server.start();
      expect(server.state).toEqual({ is: "failed", reason: redirected(other.origin) });
    }
    expect(readLog(other.log)).toEqual([]);
  });

  // The SSE transport's event stream keeps only the message of what its fetch threw.
  it("fails on a redirect of an sse server's event stream to another origin with the same line", async () => {
    const { dir, make } = await setup();
    const other = await elsewhere(dir);
    const moved = http.createServer((_req, res) => {
      res.writeHead(307, { location: `${other.origin}/sse`, connection: "close" }).end();
    });
    await new Promise<void>((resolve) => moved.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => void moved.close());
    const url = `http://127.0.0.1:${(moved.address() as AddressInfo).port}/sse`;
    const headers = { "X-Key": "static" };
    const server = make({ ...base, entry: { kind: "sse", url, headers }, asWritten: { url, headers } });
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: redirected(other.origin) });
    expect(readLog(other.log)).toEqual([]);
  });

  // Choice 1 (b): a redirect within the server's own origin is left to the library.
  it("follows a redirect within its origin that keeps the method", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log, slash: true });
    const server = make(remote(fake.url, { "X-Key": "static" }));
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(new Set(posts(log).map((m) => m.path))).toEqual(new Set(["/mcp", "/mcp/"]));
  });

  // Decision 27, without sign-in: the hop is the same request, so it carries the entry's headers.
  it("sends the helper's and the static headers on a hop within its origin, and fails a hop on elsewhere", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log, slash: true });
    const helper = fakeHelper(dir);
    helper.give({ "x-key": "from the helper" });
    const helped = { helper: { cwd: dir, project: false } };
    const server = make(remote(fake.url, { "X-Other": "kept" }, helper.command), helped);
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    const hops = posts(log).filter((m) => m.path === "/mcp/");
    expect(hops.length).toBeGreaterThan(0);
    expect(keys(hops)).toEqual(new Set(["from the helper kept"]));

    const other = await elsewhere(dir);
    const onward = await httpFake(dir, { slash: true, redirect: `${other.origin}/mcp` });
    const second = make(remote(onward.url, { "X-Other": "kept" }, helper.command), helped);
    await second.start();
    expect(second.state).toEqual({ is: "failed", reason: redirected(other.origin) });
    expect(readLog(other.log)).toEqual([]);
  });

  // Decision 27: a hop is a call with the very headers object of a request its own address, or a hop of it, answered
  // with a redirect within the origin, as the library's fetchWithinOrigin passes it on; any other call is not.
  it.each([true, false])("connectionFetch, signing in %s, takes a request's own hops alone as it", async (signs) => {
    const { dir, log } = await setup();
    // Each POST past the slash's 307 is answered 200, as a tool call (whose status is heard) has no session.
    const fake = await httpFake(dir, { log, slash: true, status: 200 });
    const url = new URL(fake.url);
    const statuses: number[] = [];
    const answered = (status: number) => statuses.push(status);
    const send = connectionFetch({ url, endpoint: () => undefined, headers: { "X-Key": "entry" }, signs, answered });
    const call = { name: "echo", arguments: {} };
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call });
    const post = async (at: string, headers: Headers) => {
      const answer = await send(new URL(at, url), { method: "POST", headers, body });
      await answer.text();
      return answer.status;
    };
    const json = () => new Headers({ "content-type": "application/json" });
    const h1 = json();
    expect(await post("/mcp", h1)).toBe(307); // not followed by fetch itself: sent with redirect "manual"
    expect(await post("/mcp/", h1)).toBe(200); // the library's hop
    expect(await post("/mcp/", json())).toBe(200); // another request's own headers, as a sign-in request's are
    const h2 = json();
    expect(await post("/mcp/", h2)).toBe(200); // a path h1's chain has, and h2's has not yet
    expect(await post("/mcp", h2)).toBe(307);
    expect(await post("/mcp/", h2)).toBe(200); // h2's own hop
    // With sign-in the entry's headers go on the server's own address and its hops; without it they are the
    // transport's requestInit's, which this call alone does not give.
    const key = signs ? "entry" : null;
    expect(posts(log).map((m) => [m.path, m.headers["x-key"] ?? null])).toEqual([
      ["/mcp", key], ["/mcp/", key], ["/mcp/", null], ["/mcp/", null], ["/mcp", key], ["/mcp/", key],
    ]);
    expect(statuses).toEqual([307, 200, 307, 200]);
  });

  // Task 11's re-check: only one request of a tools/call, resources/read or prompts/get is heard, so no list,
  // initialize, notification, reply or batch the server refuses starts a refresh.
  it("connectionFetch hears a tool call, a resource read and a prompt alone", async () => {
    const { dir } = await setup();
    const fake = await httpFake(dir, { status: 403 });
    const url = new URL(fake.url);
    const heard: string[] = [];
    let now = "";
    const answered = () => heard.push(now);
    const send = connectionFetch({ url, endpoint: () => undefined, headers: {}, signs: false, answered });
    const rpc = (m: object) => ({ jsonrpc: "2.0", ...m });
    const call = { name: "echo", arguments: {} };
    const bodies: Record<string, unknown> = {
      "an initialize": rpc({ id: 1, method: "initialize", params: {} }),
      "a tools/list": rpc({ id: 2, method: "tools/list" }),
      "a notification": rpc({ method: "notifications/initialized" }),
      "a tools/call without an id": rpc({ method: "tools/call", params: call }),
      "a reply": rpc({ id: "fake-1", result: {} }),
      "a batch of one tools/call": [rpc({ id: 3, method: "tools/call", params: call })],
      "a tools/call": rpc({ id: 4, method: "tools/call", params: call }),
      "a resources/read": rpc({ id: 5, method: "resources/read", params: { uri: "note://a" } }),
      "a prompts/get": rpc({ id: 6, method: "prompts/get", params: { name: "greet" } }),
    };
    const headers = { "content-type": "application/json" };
    for (const [name, m] of Object.entries(bodies)) {
      now = name;
      const answer = await send(url, { method: "POST", headers, body: JSON.stringify(m) });
      await answer.text();
      expect(answer.status).toBe(403);
    }
    expect(heard).toEqual(["a tools/call", "a resources/read", "a prompts/get"]);
  });

  // Decision 22: a stop that comes while the helper runs kills it, and the start goes no further.
  it("makes no connection when stopped while its helper runs, and the next start connects once", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const helper = fakeHelper(dir);
    helper.hold();
    // Out of the test's folder, which Windows keeps a moment for a killed program that worked in it.
    const server = make(remote(fake.url, {}, helper.command), { helper: { cwd: tmpdir(), project: false } });
    const starting = server.start();
    await vi.waitFor(() => expect(helper.runs()).toHaveLength(1), WAIT);
    await server.stop();
    // Gone before its go file exists, and within WAIT's 5 s, before its own 10 s limit, so the stop killed it.
    await vi.waitFor(() => expect(alive(helper.runs()[0]!.pid)).toBe(false), WAIT);
    await starting;
    expect(readLog(log)).toEqual([]);
    helper.go(); // for the next start's run
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    expect(helper.runs()).toHaveLength(2);
    expect(posts(log).filter((m) => m.body.method === "initialize")).toHaveLength(1);
  });

  // Two Reconnects close together: the second start kills the first one's helper, which would go no further.
  it("kills an earlier start's helper when a newer start begins, and connects once", async () => {
    const { dir, make, log } = await setup();
    const fake = await httpFake(dir, { log });
    const helper = fakeHelper(dir);
    helper.hold();
    const server = make(remote(fake.url, {}, helper.command), { helper: { cwd: tmpdir(), project: false } });
    const first = server.start();
    await vi.waitFor(() => expect(helper.runs()).toHaveLength(1), WAIT);
    const second = server.start();
    await vi.waitFor(() => expect(helper.runs()).toHaveLength(2), WAIT);
    // Gone before its go file exists, and within WAIT's 5 s, before its own 10 s limit, so the newer start killed it.
    await vi.waitFor(() => expect(alive(helper.runs()[0]!.pid)).toBe(false), WAIT);
    await first;
    helper.go();
    await second;
    expect(names(server)).toEqual(TOOLS);
    expect(posts(log).filter((m) => m.body.method === "initialize")).toHaveLength(1);
  });
});

// 8c-2a plan, Task 11 (decisions 18-21, 23, 25 and 27): a 401 or 403 runs the helper again on a new connection, the
// calls in flight finishing on the old one.
describe("a remote server's refresh at a 401 or 403", () => {
  const posts = (log: string) => readLog(log).filter((m) => m.http === "POST");
  const callsOf = (log: string) => posts(log).filter((m) => m.body.method === "tools/call");
  const initializes = (log: string) => posts(log).filter((m) => m.body.method === "initialize");
  // A fake whose every POST needs the x-token held in `token`, and a ready server whose helper gives it; `turn` changes
  // both. The fake's wait tool answers once `gate` exists. `more` gives the fake's other options.
  async function turned(more: (dir: string) => FakeOptions = () => ({})) {
    const t = await setup();
    const token = path.join(t.dir, "token.txt");
    const gate = path.join(t.dir, "gate");
    await writeFile(token, "t1");
    const fake = await httpFake(t.dir, { log: t.log, tokenFile: token, gate, ...more(t.dir) });
    const helper = fakeHelper(t.dir);
    helper.give({ "x-token": "t1" });
    // Out of the test's folder, which Windows keeps a moment for a killed program that worked in it.
    const server = t.make(remote(fake.url, {}, helper.command), { helper: { cwd: tmpdir(), project: false } });
    await server.start();
    expect(names(server)).toEqual(TOOLS);
    const turn = async (to: string) => {
      await writeFile(token, to);
      helper.give({ "x-token": to });
    };
    return { ...t, gate, helper, server, turn };
  }
  // A call to wait, once the fake has it; in an object, as an async function's promise would wait for the call itself.
  const inFlight = async (t: Awaited<ReturnType<typeof turned>>) => {
    const waiting = t.server.callTool("wait", {}, {});
    await vi.waitFor(() => expect(callsOf(t.log).filter((m) => m.body.params.name === "wait")).toHaveLength(1), WAIT);
    return { waiting };
  };

  it("fails a call answered 401, sent once, runs the helper again, the next call sent with the new token", async () => {
    const t = await turned(() => ({ resources: [{ uri: "note://a", name: "a", text: "hi" }] }));
    t.helper.hold();
    await t.turn("t2");
    await expect(t.server.callTool("echo", { text: "first" }, {})).rejects.toThrow();
    const refresh = t.server.refreshing;
    expect(refresh).toBeDefined();
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
    expect(t.helper.runs()).toHaveLength(2);
    expect(textOf(await t.server.callTool("echo", { text: "second" }, {}))).toBe("second");
    const sent = callsOf(t.log).map((m) => [m.body.params.arguments.text, m.headers["x-token"]]);
    expect(sent).toEqual([["first", "t1"], ["second", "t2"]]);
    expect(t.server.connection).toBe(1);
    expect(t.server.refreshing).toBeUndefined();
    // The new connection's resources, listed before it was the server's, are its own.
    await t.server.listed;
    expect(t.server.resources.map((r) => r.uri)).toEqual(["note://a"]);
  });

  it("starts one refresh for two calls answered 403 at once, a call in flight answered on the old one", async () => {
    const t = await turned(() => ({ denyStatus: 403 }));
    const { waiting } = await inFlight(t);
    t.helper.hold();
    await t.turn("t2");
    const two = [t.server.callTool("echo", { text: "a" }, {}), t.server.callTool("echo", { text: "b" }, {})];
    expect(await Promise.allSettled(two)).toMatchObject([{ status: "rejected" }, { status: "rejected" }]);
    const refresh = t.server.refreshing!;
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
    await writeFile(t.gate, "");
    expect(textOf(await waiting)).toBe("waited");
    expect(textOf(await t.server.callTool("echo", { text: "c" }, {}))).toBe("c");
    expect(t.helper.runs()).toHaveLength(2);
    const session = (name: string, text?: string) =>
      callsOf(t.log)
        .filter((m) => m.body.params.name === name && m.body.params.arguments?.text === text)
        .map((m) => m.headers["mcp-session-id"]);
    expect([session("wait"), session("echo", "c")]).toEqual([["session-1"], ["session-2"]]);
  });

  it("fails a refresh whose helper fails, the server failed with its reason, a call in flight finishing", async () => {
    const t = await turned();
    const { waiting } = await inFlight(t);
    t.helper.mode("fail");
    t.helper.hold();
    await t.turn("t2");
    await expect(t.server.callTool("echo", { text: "x" }, {})).rejects.toThrow();
    const refresh = t.server.refreshing!;
    t.helper.go();
    expect(await refresh).toEqual({ is: "failed", reason: "it exited with code 3", helper: true });
    expect(t.server.state).toEqual({ is: "failed", reason: "its headersHelper failed: it exited with code 3" });
    await writeFile(t.gate, "");
    expect(textOf(await waiting)).toBe("waited");
    expect(initializes(t.log)).toHaveLength(1);
  });

  // Decision 21: the stop kills the refresh's helper, and nothing more is opened.
  it("drops a refresh stopped while its helper runs, killing the helper, and opens no new connection", async () => {
    const t = await turned();
    t.helper.hold();
    await t.turn("t2");
    await expect(t.server.callTool("echo", { text: "x" }, {})).rejects.toThrow();
    const refresh = t.server.refreshing!;
    await vi.waitFor(() => expect(t.helper.runs()).toHaveLength(2), WAIT);
    await t.server.stop();
    expect(await refresh).toEqual({ is: "dropped" });
    // Gone before its go file exists, and within WAIT's 5 s, before its own 10 s limit, so the stop killed it.
    await vi.waitFor(() => expect(alive(t.helper.runs()[1]!.pid)).toBe(false), WAIT);
    expect(initializes(t.log)).toHaveLength(1);
  });

  it("drops a refresh stopped while its new connection's initialize waits, which then goes no further", async () => {
    let second = "";
    const t = await turned((dir) => ({ holdSecond: (second = path.join(dir, "second")) }));
    await t.turn("t2");
    await expect(t.server.callTool("echo", { text: "x" }, {})).rejects.toThrow();
    const refresh = t.server.refreshing!;
    await vi.waitFor(() => expect(initializes(t.log)).toHaveLength(2), WAIT);
    const state = t.server.state;
    await t.server.stop();
    expect(await refresh).toEqual({ is: "dropped" });
    expect(t.server.state).toEqual(state);
    // The held initialize answered, and a start after it: nothing came from the dropped connection in between.
    await writeFile(second, "");
    await t.server.start();
    expect(names(t.server)).toEqual(TOOLS);
    const methods = posts(t.log).map((m) => m.body.method);
    const [, at, next] = methods.flatMap((m, i) => (m === "initialize" ? [i] : []));
    expect(methods.slice(at! + 1, next)).toEqual([]);
  });

  // Decision 25: a connection a refresh replaced is the server's own until it closes, so a stop closes it too.
  it("closes the old connection at a stop while a call still drains on it, the call failing", async () => {
    const t = await turned(() => ({ denyTool: "denied" }));
    const { waiting } = await inFlight(t);
    await expect(t.server.callTool("denied", {}, {})).rejects.toThrow();
    expect(await t.server.refreshing).toEqual({ is: "ready" });
    // Taken before the stop, which fails the call before it ends.
    const failing = expect(waiting).rejects.toThrow();
    await t.server.stop();
    await failing;
    const old = posts(t.log).filter((m) => m.headers["mcp-session-id"] === "session-1");
    expect(old.at(-1)!.body.params.name).toBe("denied");
  });

  // Decision 27: a hop within the origin is the same request, so its 403 or 401 starts the refresh.
  it.each(["a denied tool's 403", "a turned token's 401"])("starts one refresh at %s at /mcp/", async (kind) => {
    const t = await turned(() => ({ slash: true, denyTool: "denied" }));
    t.helper.hold();
    if (kind.includes("token")) await t.turn("t2");
    await expect(t.server.callTool(kind.includes("token") ? "echo" : "denied", {}, {})).rejects.toThrow();
    expect(posts(t.log).at(-1)!.path).toBe("/mcp/");
    const refresh = t.server.refreshing;
    expect(refresh).toBeDefined();
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
    expect(t.helper.runs()).toHaveLength(2);
  });

  // Only a POST carries a call, a read or an initialize: a server refusing the event stream's GET, as a gateway may
  // refuse a method it does not map, would otherwise be refreshed again and again (Task 11's review).
  it("starts no refresh when the event stream's GET is answered 403", async () => {
    const t = await turned(() => ({ getStatus: 403 }));
    expect(textOf(await t.server.callTool("echo", { text: "a" }, {}))).toBe("a"); // its tools/call answers the GET
    expect(textOf(await t.server.callTool("echo", { text: "b" }, {}))).toBe("b"); // a round trip after that answer
    expect(readLog(t.log).filter((m) => m.http === "GET")).toHaveLength(1);
    expect(t.server.refreshing).toBeUndefined();
    expect(t.helper.runs()).toHaveLength(1);
    expect(initializes(t.log)).toHaveLength(1);
    expect(t.server.state.is).toBe("ready");
  });

  // Only a tool call, a resource read or a prompt starts a refresh: a list a connection asks for beside its tools,
  // refused once it is ready, would otherwise refresh again at each new connection (Task 11's re-check).
  const offers = (denyMethod: string) => ({
    denyMethod,
    resources: [{ uri: "note://a", name: "a", text: "hi" }],
    prompts: [{ name: "greet", messages: [{ role: "user", content: { type: "text", text: "Hello." } }] }],
  });
  it.each(["resources/list", "prompts/list"])("starts no refresh at %s answered 403 once ready", async (method) => {
    const t = await turned(() => offers(method));
    await writeFile(t.gate, ""); // the 403, held until now, comes after the start
    await t.server.listed;
    expect(t.server.refreshing).toBeUndefined();
    expect(t.helper.runs()).toHaveLength(1);
    expect(initializes(t.log)).toHaveLength(1);
    expect(t.server.state.is).toBe("ready");
    expect(names(t.server)).toEqual(TOOLS);
    expect(method === "resources/list" ? t.server.resources : t.server.prompts).toEqual([]);
  });

  // The note for a call whose own 401 or 403 began the refresh for its connection, or came while it ran (tools.ts,
  // refused; the user's choice, 2026-11-18, from the terminal check).
  const noted = (message: string, status: number) => `${message} [noted ${status}]`;
  it("notes two calls at once answered 401 on the connection a refresh is for", async () => {
    const t = await turned();
    t.helper.hold();
    await t.turn("t2");
    const two = ["a", "b"].map((text) => t.server.callTool("echo", { text }, { noted }));
    const said = (await Promise.allSettled(two)).map((s) => (s.status === "rejected" ? s.reason.message : s.status));
    expect(said).toEqual(Array(2).fill("Error POSTing to endpoint: refused [noted 401]"));
    const refresh = t.server.refreshing!;
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
  });

  // A call sent on the first connection, its 403 held until `gate`, comes after a second refresh, from the second
  // connection, began: a refresh for another connection than its own.
  it("notes no call refused on a connection that the refresh running is not for", async () => {
    const t = await turned(() => ({ denyMethod: "tools/call" }));
    const first = t.server.callTool("echo", { text: "held" }, { noted });
    await vi.waitFor(() => expect(callsOf(t.log)).toHaveLength(1), WAIT);
    await t.turn("t2");
    await expect(t.server.callTool("echo", {}, {})).rejects.toThrow(); // its 401 begins the first refresh
    expect(await t.server.refreshing).toEqual({ is: "ready" });
    t.helper.hold();
    await t.turn("t3");
    await expect(t.server.callTool("echo", {}, {})).rejects.toThrow(); // and this one the second
    const refresh = t.server.refreshing!;
    await writeFile(t.gate, "");
    await expect(first).rejects.toMatchObject({ message: "Error POSTing to endpoint: refused", status: 403 });
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
  });

  it.each(["resources/read", "prompts/get"])("starts a refresh at %s answered 403", async (method) => {
    const t = await turned(() => offers(method));
    await writeFile(t.gate, "");
    t.helper.hold();
    const asked =
      method === "resources/read" ? t.server.readResource("note://a", {}) : t.server.getPrompt("greet", {}, {});
    await expect(asked).rejects.toThrow();
    const refresh = t.server.refreshing;
    expect(refresh).toBeDefined();
    t.helper.go();
    expect(await refresh).toEqual({ is: "ready" });
    expect(t.helper.runs()).toHaveLength(2);
  });
});
