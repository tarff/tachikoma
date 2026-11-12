import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { running } from "../../src/exec/local.js";
import type { ServerConfig, ServerEntry } from "../../src/mcp/config.js";
import { NotReached, Server } from "../../src/mcp/server.js";
import { removeTree } from "../helpers.js";
import { type FakeOptions, fakeServer, httpFake, readLog } from "./fake.js";

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
const remote = (url: string, headers: Record<string, string> = {}): ServerConfig => ({ ...base, entry: { kind: "http", url, headers }, asWritten: { url, headers } });

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
  const make = (config: ServerConfig, opts: { env?: NodeJS.ProcessEnv; startMs?: number; root?: string } = {}) => {
    const server = new Server(config, { root: opts.root ?? dir, env: opts.env ?? process.env, onChange, startMs: opts.startMs });
    servers.push(server);
    return server;
  };
  const log = path.join(dir, "log.jsonl");
  const script = (opts: FakeOptions = {}) => fakeServer(dir, { log, ...opts });
  return { dir, make, onChange, log, script };
}

const textOf = (result: { content: unknown }) => (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
const names = (server: Server) => (server.state.is === "ready" ? server.state.tools.map((t) => t.name) : server.state);
const TOOLS = ["echo", "error", "picture", "structured", "slow", "progress", "whoami", "ask", "change", "exit"];
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
