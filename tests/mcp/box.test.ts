import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { running } from "../../src/exec/local.js";
import {
  badNameLine,
  BOX_WORK,
  envBlock,
  execArgs,
  groupFile,
  INNER,
  NOT_FOUND,
  notFoundLine,
  unstoppedLine,
} from "../../src/mcp/box.js";
import type { ServerConfig, ServerEntry } from "../../src/mcp/config.js";
import { Server } from "../../src/mcp/server.js";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { killInBox, killLine } from "../../src/sandbox/executor.js";
import { tempDir } from "../helpers.js";
import { type FakeOptions, fakeServer, readLog, standinBox } from "./fake.js";

const NUL = String.fromCharCode(0);

// 8c-2a plan, Task 3: the box server's start command and the block of its variables (decisions 2 and 3). The scripts
// themselves run in the real box in Task 5's tests.
describe("envBlock", () => {
  it("gives each entry as NAME=VALUE and a NUL, then one more NUL, values whole", () => {
    const got = envBlock({ A: "x \t", B: "one\ntwo", C: "", D: "end\n" });
    expect(got).toEqual({ block: Buffer.from(`A=x \t${NUL}B=one\ntwo${NUL}C=${NUL}D=end\n${NUL}${NUL}`) });
  });

  it("gives a single NUL for no variables", () => {
    expect(envBlock({})).toEqual({ block: Buffer.from(NUL) });
  });

  it("refuses a name the box cannot take, naming the first", () => {
    expect(envBlock({ OK: "1", "BAD-NAME": "2", "9LIVES": "3" })).toEqual({ bad: "BAD-NAME" });
    expect(envBlock({ "9LIVES": "3" })).toEqual({ bad: "9LIVES" });
    expect(envBlock({ "A=B": "4" })).toEqual({ bad: "A=B" });
  });
});

describe("execArgs", () => {
  const group = "/tmp/tachikoma-g1";
  const args = execArgs("b0x", group, "npx", ["-y", "some server", "$HOME"]);

  it("is docker exec -i in /work, never -t, with the server's words as arguments, as given", () => {
    expect(args.slice(0, 7)).toEqual(["exec", "-i", "-w", BOX_WORK, "b0x", "bash", "-c"]);
    expect(BOX_WORK).toBe("/work");
    expect(args).not.toContain("-t");
    expect(args.slice(8)).toEqual(["_", INNER, "npx", "-y", "some server", "$HOME"]);
  });

  it("runs its words in a group of its own, writing and removing the group's file and its .stop file", () => {
    expect(args[7]).toBe(
      "exec 3>&2 2>/dev/null; " +
        `setsid -w bash -c 'echo $$ > ${group}; [ -e ${group}.stop ] && exit; exec bash -c "$@"' _ "$@" 2>&3 3>&-; ` +
        `s=$?; rm -f ${group} ${group}.stop; exit $s`,
    );
  });

  it("takes a new group file in the box's /tmp each time", () => {
    const a = groupFile();
    expect(a).toMatch(/^\/tmp\/tachikoma-[0-9a-f-]{36}$/);
    expect(groupFile()).not.toBe(a);
  });
});

describe("INNER", () => {
  it("reads with IFS= read -r -d '', looks the command up after its exports, and says when it is not found", () => {
    expect(INNER).toContain("IFS= read -r -d ''");
    // The command is kept as $1 before any entry is exported, so no entry (BASH_ARGV0 sets $0) can change it.
    expect(INNER.startsWith('set -- "$0" "$@"; ')).toBe(true);
    // x exports the entries; the lookup comes after the loop's end and x's call, and is of the kept command, $1.
    expect(INNER).toContain('done; x "${a[@]}"; command -v "$1" >/dev/null');
    expect(INNER).toContain(NOT_FOUND);
    expect(NOT_FOUND).toBe("tachikoma: not found");
    expect(INNER).toContain("exit 127");
    expect(INNER).toContain("exit 2");
    expect(INNER).toMatch(/exec "\$@"$/);
  });
});

describe("the red lines' reasons", () => {
  it("are the approved words", () => {
    expect(notFoundLine("uvx mcp-x")).toBe(
      'uvx mcp-x was not found in the box; if it needs this computer, add "host": true to its entry in ' +
        "~/.tachikoma/settings.json",
    );
    expect(badNameLine("BAD-NAME")).toBe(
      'its env has the name "BAD-NAME", which the box cannot take: a name there is letters, digits and _, ' +
        "not starting with a digit",
    );
  });
});

// Decision 24: inGroup's kill, shared with the box server.
describe("killLine and killInBox", () => {
  it("killLine is inGroup's kill line", () => {
    const group = "/tmp/tachikoma-g1";
    expect(killLine(group)).toBe(
      `touch ${group}.stop; kill -KILL -- -"$(cat ${group} 2>/dev/null)" 2>/dev/null; exit 0`,
    );
  });

  const answering = (answer: () => ReturnType<DockerRun>) => {
    const calls: string[][] = [];
    const run: DockerRun = (args) => {
      calls.push(args);
      return answer();
    };
    return { run, calls };
  };

  it("runs the kill line in the box, and gives undefined when it exits 0", async () => {
    const fake = answering(async () => ({ code: 0, out: "", err: "" }));
    expect(await killInBox(fake.run, "b0x", "/tmp/tachikoma-g1")).toBeUndefined();
    expect(fake.calls).toEqual([["exec", "b0x", "bash", "-c", killLine("/tmp/tachikoma-g1")]]);
  });

  it("gives no docker program's words, Docker's error output, the box stopped, or the error's message", async () => {
    const kill = (answer: () => ReturnType<DockerRun>) => killInBox(answering(answer).run, "b0x", "/tmp/tachikoma-g1");
    expect(await kill(async () => "missing")).toBe("no docker program is on PATH any more");
    expect(await kill(async () => ({ code: 1, out: "", err: "Error: boom\n" }))).toBe("Error: boom");
    expect(await kill(async () => ({ code: 1, out: "", err: "" }))).toBe("the box stopped");
    expect(await kill(() => Promise.reject(new Error("spawn docker EACCES")))).toBe("spawn docker EACCES");
  });
});

// 8c-2a plan, Task 4: a server started in the box, through the stand-in Docker (tests/standin/dockerExec.mjs), whose
// servers run on this machine (decisions 1, 3-8 and 24). Real Docker runs the same in Task 5's tests.
const base: Omit<ServerConfig, "entry" | "asWritten"> = {
  name: "fake", safe: "fake", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
};
const local = (args: string[], over: Partial<Extract<ServerEntry, { kind: "stdio" }>> = {}): ServerConfig => ({
  ...base,
  entry: { kind: "stdio", command: process.execPath, args, env: {}, ...over },
  asWritten: { command: process.execPath, args },
});
const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("");
const BOOM = { code: 1, out: "", err: "Error: boom\n" };
const UNREACHABLE = {
  code: 1,
  out: "",
  err: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
};
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
// The group file a start's outer script names.
const groupIn = (args: string[]) => /\/tmp\/tachikoma-[0-9a-f-]{36}/.exec(args[7] ?? "")![0];

// The test's own folder, the project's root, the stand-in box recording there, and its servers, each stopped before the
// folder is removed, as on Windows a running server holds the folder it works in; then any left running is killed.
async function setup(opts: { gone?: string } = {}) {
  const dir = tempDir("tachi-mcp-box-");
  const fake = standinBox(dir, opts);
  const servers: Server[] = [];
  onTestFinished(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await fake.killAll();
  });
  const make = (config: ServerConfig, env: NodeJS.ProcessEnv = process.env) => {
    const server = new Server(config, { root: dir, env, onChange: () => {}, box: fake.box });
    servers.push(server);
    return server;
  };
  const script = (o: FakeOptions = {}) => fakeServer(dir, o);
  const pidFile = path.join(dir, "pid");
  // One that keeps running when its input closes, with a child of its own.
  const stubborn = () => script({ stubborn: true, pidFile, childPidFile: path.join(dir, "child-pid") });
  return { dir, fake, make, script, stubborn, pidFile };
}

describe("a server in the box, through the stand-in Docker", () => {
  it("starts as docker exec -i in /work, never -t, with no value of its env in the arguments", async () => {
    const { fake, make, script } = await setup();
    const fakeScript = await script();
    const server = make(local([fakeScript, "two words"], { env: { SECRET_ONE: "value-from-the-entry" } }));
    await server.start();
    expect(server.state.is).toBe("ready");
    const [start, ...more] = fake.started();
    expect(more).toEqual([]);
    expect(start!.args.slice(0, 5)).toEqual(["exec", "-i", "-w", "/work", "b0x"]);
    expect(start!.args).not.toContain("-t");
    expect(start!.args.slice(-3)).toEqual([process.execPath, fakeScript, "two words"]);
    expect(start!.args.join(" ")).not.toContain("value-from-the-entry");
  });

  it("gives the docker program the session's DOCKER_HOST and DOCKER_CONFIG, never the entry's, nor a key", async () => {
    const { fake, make, script } = await setup();
    const session = { DOCKER_HOST: "tcp://session:2375", DOCKER_CONFIG: "/session/docker" };
    const env = { ...process.env, ...session, ANTHROPIC_API_KEY: "sk-test-not-a-key" };
    const entry = { DOCKER_HOST: "tcp://entry:2375", DOCKER_CONFIG: "/entry/docker" };
    const server = make(local([await script({ show: ["DOCKER_HOST", "DOCKER_CONFIG"] })], { env: entry }), env);
    await server.start();
    const [start] = fake.started();
    expect(start!.env.DOCKER_HOST).toBe("tcp://session:2375");
    expect(start!.env.DOCKER_CONFIG).toBe("/session/docker");
    expect(start!.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The server itself gets the entry's, over its input.
    expect(JSON.parse(textOf(await server.callTool("whoami", {}, {}))).env).toEqual(entry);
  });

  it("gives the server its entry's variables whole, CLAUDE_PROJECT_DIR=/work, and roots of file:///work", async () => {
    const { make, script } = await setup();
    const vars = { LINES: "one\ntwo", TABBED: "end\t" };
    const server = make(local([await script({ show: ["LINES", "TABBED"] })], { env: vars }));
    await server.start();
    const seen = JSON.parse(textOf(await server.callTool("whoami", {}, {})));
    expect(seen.env).toEqual(vars);
    expect(seen.project).toBe("/work");
    const roots = await server.callTool("ask", { method: "roots/list" }, {});
    expect(JSON.parse(textOf(roots))).toEqual({ roots: [{ uri: "file:///work" }] });
  });

  it("fails with the not-found line for a command the box lacks, its control characters escaped", async () => {
    const { make } = await setup();
    const server = make(local([], { command: "tachi-no-such-server" }));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: notFoundLine("tachi-no-such-server") });
    const odd = make(local([], { command: `tachi-no-such${String.fromCharCode(27)}server` }));
    await odd.start();
    expect(odd.state).toEqual({ is: "failed", reason: notFoundLine("tachi-no-such\\u001bserver") });
  });

  it("refuses a variable name the box cannot take, starting nothing", async () => {
    const { fake, make, script } = await setup();
    const server = make(local([await script()], { env: { OK: "1", "ProgramFiles(x86)": "C:\\Program Files (x86)" } }));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: badNameLine("ProgramFiles(x86)") });
    expect(fake.started()).toEqual([]);
  });

  it("runs nothing in the box to stop a server that ends when its input closes", async () => {
    const { fake, make, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    await server.stop();
    expect(fake.calls).toEqual([]);
    await vi.waitFor(() => expect(alive(fake.started()[0]!.self)).toBe(false), WAIT);
  });

  it("kills a stubborn one's group in the box through the box's DockerRun, and it ends", async () => {
    const { fake, make, stubborn, pidFile } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    const pid = pidIn(pidFile);
    await server.stop();
    expect(fake.calls).toEqual([["exec", "b0x", "bash", "-c", killLine(groupIn(fake.started()[0]!.args))]]);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), WAIT);
  });

  // At once: a server that ends when its input closes has had no time to, so its docker exec ends by the kill, where
  // the stop without `exit` above sees it end by itself.
  it("at the exit, runs nothing in the box and ends the docker exec at once, not waiting for the server", async () => {
    const { fake, make, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    const exec = [...running].find((c) => c.pid === fake.started()[0]!.self)!;
    await server.stop({ exit: true });
    expect(fake.calls).toEqual([]);
    await vi.waitFor(() => expect(exec.signalCode).not.toBeNull(), WAIT);
    expect(exec.exitCode).toBeNull();
  });

  it("at the exit, ends a stubborn one's docker exec too, running nothing in the box", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    await server.stop({ exit: true });
    expect(fake.calls).toEqual([]);
    await vi.waitFor(() => expect(alive(fake.started()[0]!.self)).toBe(false), WAIT);
  });

  it("gives its exit's reason when a server ends while the box still runs", async () => {
    const { fake, make, script } = await setup();
    const server = make(local([await script()]));
    await server.start();
    await server.callTool("exit", { code: 3, stderr: "x" }, {}).catch(() => {});
    const stopped = { is: "stopped", reason: "it exited with code 3: x", retry: false };
    await vi.waitFor(() => expect(server.state).toEqual(stopped), WAIT);
    expect(fake.calls.map((c) => c[0])).toEqual(["inspect"]);
  });

  it("shows the box stopped when a server ends while the box is gone, and refuses a start once it broke", async () => {
    const { fake, make, script } = await setup({ gone: "Error response from daemon: No such container: b0x" });
    const server = make(local([await script()]));
    await server.start();
    await server.callTool("exit", { code: 1 }, {}).catch(() => {});
    const stopped = { is: "stopped", reason: "the box stopped", retry: false };
    await vi.waitFor(() => expect(server.state).toEqual(stopped), WAIT);
    fake.box.state.fail("Docker stopped");
    const next = make(local([await script()]));
    await next.start();
    expect(next.state).toEqual({ is: "failed", reason: "the box stopped" });
    expect(fake.started()).toHaveLength(1);
  });
});

// Decision 24: a stop whose kill in the box failed is tried again before any new start, and confirmed only on proof.
describe("a box server's stop that failed", () => {
  const blocked = (reason: string) => ({ is: "failed", reason: unstoppedLine(reason) });

  it("blocks a new start while its kill still fails, and lets one copy start once it works", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push(BOOM);
    await server.stop();
    // A restart, as /mcp's Reconnect makes one: the kill is tried again and fails.
    fake.kills.push(BOOM);
    await server.start();
    expect(server.state).toEqual(blocked("Error: boom"));
    expect(unstoppedLine("Error: boom")).toBe(
      "its earlier copy could not be stopped in the box (Error: boom), so it was not started again",
    );
    expect(fake.started()).toHaveLength(1);
    // The kill works now: exactly one more copy starts.
    await server.start();
    expect(server.state.is).toBe("ready");
    expect(fake.started()).toHaveLength(2);
    expect(fake.order()).toEqual(["start", "kill", "inspect", "kill", "inspect", "kill", "start"]);
  });

  it("keeps the record while the daemon is unreachable, and kills before a new start once Docker is back", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push(BOOM);
    await server.stop();
    fake.inspects.push(UNREACHABLE);
    fake.kills.push(UNREACHABLE);
    await server.start();
    expect(server.state).toEqual(blocked(UNREACHABLE.err.trim()));
    expect(fake.started()).toHaveLength(1);
    // Docker is back, the old copy still running: inspect says true, so the kill runs, and only then a new start.
    await server.start();
    expect(server.state.is).toBe("ready");
    expect(fake.order().slice(-3)).toEqual(["inspect", "kill", "start"]);
    expect(fake.started()).toHaveLength(2);
  });

  it("is cleared without a kill when inspect says the box is not running", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push(BOOM);
    await server.stop();
    fake.inspects.push({ code: 0, out: "false\n", err: "" });
    await server.start();
    expect(server.state.is).toBe("ready");
    expect(fake.order()).toEqual(["start", "kill", "inspect", "start"]);
  });

  it("is cleared once Tachikoma's own removal of the box succeeded", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push(BOOM);
    await server.stop();
    // As DockerExecutor.stop sets it once its rm -f exits 0 (tests/sandbox/executor.test.ts).
    fake.box.state.removed = true;
    await server.start();
    expect(server.state.is).toBe("ready");
    expect(fake.order()).toEqual(["start", "kill", "start"]);
  });

  // The spec review of Task 4: a stop that comes while the retries wait on Docker holds; the start goes no further.
  it("starts nothing when a stop comes while the retries wait on Docker", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push(BOOM);
    await server.stop();
    let answer!: (got: Awaited<ReturnType<DockerRun>>) => void;
    fake.inspects.push(new Promise((resolve) => (answer = resolve)));
    const starting = server.start();
    await vi.waitFor(() => expect(fake.calls.at(-1)?.[0]).toBe("inspect"), WAIT);
    await server.stop();
    answer({ code: 0, out: "false\n", err: "" }); // the record is confirmed, so only the stop keeps the start back
    await starting;
    expect(fake.started()).toHaveLength(1);
    expect(server.state.is).not.toBe("ready");
  });

  it("is kept when there is no docker program", async () => {
    const { fake, make, stubborn } = await setup();
    const server = make(local([await stubborn()]));
    await server.start();
    fake.kills.push("missing");
    await server.stop();
    fake.inspects.push("missing");
    fake.kills.push("missing");
    await server.start();
    expect(server.state).toEqual(blocked("no docker program is on PATH any more"));
    expect(fake.started()).toHaveLength(1);
  });

  // 8c-2a plan, Task 6: Servers gives the box to every copy with the sandbox on, a host one's too, so its retries can
  // run; one given records and no box cannot prove them, so it stays blocked, starting nothing, and never throws.
  it("runs a host entry given the box on this computer, and starts none with records but no box", async () => {
    const { dir, fake, make, script } = await setup();
    const host = make({ ...local([await script()]), host: true });
    await host.start();
    expect(host.state.is).toBe("ready");
    expect(JSON.parse(textOf(await host.callTool("whoami", {}, {}))).project).toBe(dir);
    expect(fake.started()).toEqual([]);
    const log = path.join(dir, "unboxed.jsonl");
    const unstopped = [{ group: "/tmp/tachikoma-g", reason: "Error: boom" }];
    const opts = { root: dir, env: process.env, onChange: () => {}, unstopped };
    const unboxed = new Server(local([await script({ log })]), opts);
    await unboxed.start();
    expect(unboxed.state).toEqual(blocked("Error: boom"));
    expect(readLog(log)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
