import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { commandEnv } from "../../src/exec/env.js";
import {
  badNameLine,
  dockerProgram,
  envBlock,
  execArgs,
  groupFile,
  type McpBox,
  notFoundLine,
} from "../../src/mcp/box.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { Server } from "../../src/mcp/server.js";
import { docker, dockerState } from "../../src/sandbox/docker.js";
import { boxLimits, boxUser, DockerExecutor, dockerRoom } from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import { removeTree } from "../helpers.js";
import { type FakeOptions, fakeServer } from "../mcp/fake.js";

// 8c-2a plan, Task 5: a server in the session's box, in real Docker: the block of its variables over its input, its
// start and its stop. These are the measurement the design asks for ("checked by the tests below, not assumed") of what
// tests/mcp/box.test.ts runs through the stand-in Docker.

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// A box from the sandbox's own image (choice 73: never pulled, network off, labelled, removed) with the test's own
// folder at /work, as tests/sandbox/boxWorkspace.test.ts's, or a skip with the reason on any Docker the box cannot use.
// `make` gives a Server in it; `fake` writes a fake server into the folder and gives its path in the box. At the end
// the servers are stopped, then the box is removed, then the folder.
async function realBox(ctx: TestContext) {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") {
    ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
  }
  const folder = await mkdtemp(path.join(os.tmpdir(), "tachi-mcpbox-"));
  let box: DockerExecutor | undefined;
  const servers: Server[] = [];
  onTestFinished(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await box?.stop();
    await removeTree(folder);
  });
  const info = await imageFor(folder);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const space = await dockerRoom();
  const got = boxLimits(undefined, space);
  if (!("limits" in got)) ctx.skip(got.problem);
  const opts = { image: info.tag, folder, limits: got.limits, user: boxUser(space), network: "off" } as const;
  box = await DockerExecutor.start({ ...opts, mounts: [], session: `test-${randomUUID()}`, labels: TEST_LABEL });
  const mcp: McpBox = { id: box.id, kind: "live", state: box.state, run: docker };
  const make = (config: ServerConfig) => {
    const server = new Server(config, { root: folder, env: process.env, onChange: () => {}, box: mcp });
    servers.push(server);
    return server;
  };
  const fake = async (o: FakeOptions = {}) => `/work/${path.basename(await fakeServer(folder, o))}`;
  return { box, make, fake };
}

const base: Omit<ServerConfig, "entry" | "asWritten"> = {
  name: "fake", safe: "fake", where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
};
const local = (command: string, args: string[], env: Record<string, string> = {}): ServerConfig => ({
  ...base,
  entry: { kind: "stdio", command, args, env },
  asWritten: { command, args },
});
const textOf = (result: { content: unknown }) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("");

// The box's processes, as `<pid> <command line>` lines, read from /proc: the image has no ps (executor.test.ts's).
const processes = async (box: DockerExecutor) =>
  (await box.exec('for p in /proc/[0-9]*; do echo "${p#/proc/} $(tr "\\0" " " < $p/cmdline)"; done', "/")).stdout;
// A fake's node, and a stubborn one's child, not a wrapper's command line that names them.
const FAKE = /^\d+ node \/work\/fake-/m;
const CHILD = /^\d+ \S*node -e setInterval/m;

const INITIALIZE = Buffer.from(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }) + "\n",
);
// The pause between pieces: the test's own, long beside a pipe's delivery, not a product number (the plan's).
const PAUSE_MS = 200;

// The docker exec a box server starts as, run by hand: `pieces` written to its input PAUSE_MS apart, and its first line
// of output, the server's first answer. Its input is then closed, which ends the fake.
async function firstAnswer(id: string, script: string, pieces: Buffer[]): Promise<unknown> {
  const child = spawn(dockerProgram(process.env)!.file, execArgs(id, groupFile(), "node", [script]), {
    env: commandEnv(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ended = new Promise((resolve) => child.once("close", resolve));
  onTestFinished(() => void (child.exitCode === null && child.signalCode === null && child.kill()));
  let out = "";
  let err = "";
  child.stderr.on("data", (chunk: Buffer) => (err += chunk));
  const line = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk;
      if (out.includes("\n")) resolve(out.slice(0, out.indexOf("\n")));
    });
    child.once("close", (code) => reject(new Error(`docker exec ended with ${code} before an answer: ${err}`)));
  });
  for (const [i, piece] of pieces.entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    child.stdin.write(piece);
  }
  const got = await line;
  child.stdin.end();
  await ended;
  return JSON.parse(got);
}

const ANSWER = {
  jsonrpc: "2.0",
  id: 1,
  result: expect.objectContaining({ serverInfo: { name: "fake", version: "1.0.0" } }),
};

// No time limit, as the other real Docker tests (choice 81).
describe("a server in the box, in real Docker", { timeout: 0 }, () => {
  it("reads the block written in three pieces with pauses between them, then answers initialize", async (ctx) => {
    const { box, fake } = await realBox(ctx);
    const made = envBlock({ ONE: "a value ", TWO: "one\ntwo", THREE: "" });
    if (!("block" in made)) throw new Error(made.bad);
    const third = Math.floor(made.block.length / 3); // each cut inside an entry
    const { block } = made;
    const pieces = [block.subarray(0, third), block.subarray(third, 2 * third), block.subarray(2 * third)];
    expect(await firstAnswer(box.id, await fake(), [...pieces, INITIALIZE])).toEqual(ANSWER);
  });

  it("reads the block and initialize written in one piece, leaving initialize to the server", async (ctx) => {
    const { box, fake } = await realBox(ctx);
    const made = envBlock({ ONE: "a value ", TWO: "one\ntwo" });
    if (!("block" in made)) throw new Error(made.bad);
    expect(await firstAnswer(box.id, await fake(), [Buffer.concat([made.block, INITIALIZE])])).toEqual(ANSWER);
  });

  // e, a and x are the inner script's own names (src/mcp/box.ts, INNER), which it unsets before the exports.
  it("gives the server its variables whole, with CLAUDE_PROJECT_DIR and its folder /work", async (ctx) => {
    const { make, fake } = await realBox(ctx);
    const vars = {
      SPACE_END: "end ", TAB_END: "end\t", LINE_END: "end\n", LINES: "one\ntwo", LEADING: "  lead", EMPTY: "",
      e: "own e", a: "own a", x: "own x",
    };
    const server = make(local("node", [await fake({ show: Object.keys(vars) })], vars));
    await server.start();
    expect(server.state.is).toBe("ready");
    const seen = JSON.parse(textOf(await server.callTool("whoami", {}, {})));
    expect(seen.env).toEqual(vars);
    expect(seen.project).toBe("/work");
    expect(seen.cwd).toBe("/work");
  });

  // Exported, BASH_ARGV0 sets bash's $0; the inner script runs its own kept copy of the command (decision 2).
  it("runs its own command whatever BASH_ARGV0 the entry sets", async (ctx) => {
    const { make, fake } = await realBox(ctx);
    const server = make(local("node", [await fake()], { BASH_ARGV0: "/usr/bin/id" }));
    await server.start();
    expect(server.state.is).toBe("ready");
    expect(JSON.parse(textOf(await server.callTool("whoami", {}, {}))).argv).toEqual([]);
  });

  // The box's own PATH has node; the entry's, without node's folders, is the one the lookup uses (decision 2).
  it("looks the command up on the entry's own PATH", async (ctx) => {
    const { box, make, fake } = await realBox(ctx);
    expect((await box.exec("command -v node", "/")).code).toBe(0);
    const without = await box.exec('IFS=:; for d in $PATH; do [ -x "$d/node" ] || printf "%s:" "$d"; done', "/");
    const PATH = without.stdout.replace(/:$/, "");
    expect(PATH).not.toBe("");
    const server = make(local("node", [await fake()], { PATH }));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: notFoundLine("node") });
  });

  it("refuses a name the box cannot take, with no process of the fake in the box", async (ctx) => {
    const { box, make, fake } = await realBox(ctx);
    const server = make(local("node", [await fake()], { OK: "1", "ProgramFiles(x86)": "C:\\Program Files (x86)" }));
    await server.start();
    expect(server.state).toEqual({ is: "failed", reason: badNameLine("ProgramFiles(x86)") });
    expect(await processes(box)).not.toMatch(FAKE);
  });

  it("fails with the not-found line for a command the box lacks", async (ctx) => {
    const { make } = await realBox(ctx);
    for (const command of ["tachi-no-such-server", "C:\\tools\\server.exe"]) {
      const server = make(local(command, []));
      await server.start();
      expect(server.state).toEqual({ is: "failed", reason: notFoundLine(command) });
    }
  });

  it("starts with the box's network off, and a stop of a stubborn one leaves none of its processes", async (ctx) => {
    const { box, make, fake } = await realBox(ctx);
    const network = await docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", box.id]);
    expect(network !== "missing" && network.out.trim()).toBe("none");
    const script = await fake({ stubborn: true, pidFile: "/work/pid", childPidFile: "/work/child-pid" });
    const server = make(local("node", [script]));
    await server.start();
    expect(server.state.is).toBe("ready");
    const before = await processes(box);
    expect(before).toMatch(FAKE);
    expect(before).toMatch(CHILD);
    await server.stop();
    const after = await processes(box);
    expect(after).not.toMatch(FAKE);
    expect(after).not.toMatch(CHILD);
  });
});
