import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, type TestContext, vi } from "vitest";
import { sandboxReady, sandboxStart, type Started } from "../../src/clilib.js";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import type { CompletionRequest, Turn } from "../../src/core/types.js";
import { onPath } from "../../src/exec/env.js";
import { gitSettings, hasSubmodules } from "../../src/safety/gitconfig.js";
import { judgeOf } from "../../src/safety/judge.js";
import { dockerState } from "../../src/sandbox/docker.js";
import { boxLimits, dockerRoom } from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import { TOOLS } from "../../src/tools/index.js";
import { shellTool } from "../../src/tools/shell.js";
import { Bus, callTool, FakeProvider, removeTree, reply } from "../helpers.js";

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// The variables a test sets itself, so the user's own never reach git: as in tests/sandbox/livelink.test.ts.
const OWN = /^(path|home|homedrive|homepath|userprofile|xdg_config_home|git_.*)$/i;

// A FakeProvider that also keeps the system prompt of each request.
class Recording extends FakeProvider {
  readonly systems: string[] = [];
  override async complete(req: CompletionRequest): Promise<Turn> {
    this.systems.push(req.system);
    return super.complete(req);
  }
}

// A test's own folder: a home, empty system and user git settings files, a data folder and a project holding a git
// repository. Git, the test's own and gitSettings's, runs only with them. At the end the box is removed, then the folder.
function world() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-session-")));
  const home = path.join(dir, "home");
  const root = path.join(dir, "project");
  mkdirSync(home);
  mkdirSync(root);
  const system = path.join(dir, "system.cfg");
  const global = path.join(dir, "global.cfg");
  writeFileSync(system, "");
  writeFileSync(global, "");
  const drive = path.parse(home).root.replace(/[\\/]$/, ""); // "C:" on Windows, "" elsewhere
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !OWN.test(name))),
    PATH: process.env.PATH,
    HOME: home,
    HOMEDRIVE: drive,
    HOMEPATH: home.slice(drive.length),
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_SYSTEM: system,
    GIT_CONFIG_GLOBAL: global,
  };
  // The data folder is the test's (choice 13 looks for it), so the user's is never looked at.
  vi.stubEnv("TACHI_DATA_DIR", path.join(dir, "data"));
  return { dir, root, env };
}

// Live link's launch as cli.tsx runs it (clilib.ts), on real Docker with the sandbox's own image (choice 73: never
// pulled, labelled, removed), or a skip with the reason on any Docker the box cannot use. The project folder may ignore
// letter case (Windows, macOS), where live link is refused (choice 104), so the check is taken as passed, as in
// livelink.test.ts; tests/cli.test.ts and mounts.test.ts test the refusal.
async function launch(ctx: TestContext, w: ReturnType<typeof world>): Promise<Started> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
  if (!onPath("git", w.env)) ctx.skip("no git on PATH");
  const info = await imageFor(w.root);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const limits = boxLimits(undefined, await dockerRoom());
  if (!("limits" in limits)) ctx.skip(limits.problem);
  const said: string[] = [];
  const io = {
    out: (line: string) => said.push(line),
    err: (line: string) => said.push(line),
    signal: new AbortController().signal,
    gitSettings: (root: string) => gitSettings(root, w.env),
    ignoresCase: () => false,
    submodules: (root: string) => hasSubmodules(root, w.env),
  };
  const ready = await sandboxReady(w.root, io);
  if ("exit" in ready) throw new Error(said.join("\n"));
  const started = await sandboxStart(w.root, ready, { network: "off", limits: undefined, session: `test-${randomUUID()}`, labels: TEST_LABEL }, io);
  if ("exit" in started) throw new Error(said.join("\n"));
  onTestFinished(() => started.box.stop());
  return started;
}

// The session cli.tsx makes for -p in auto mode: the gate headless, the judge a FakeProvider that allows, and the tools,
// prompt and context the launch gave.
function headless(started: Started, lead: FakeProvider, judge: FakeProvider) {
  const bus = new Bus();
  const gate = new PermissionGate("auto", async () => false, "Not allowed in -p mode, where nobody can approve it", {
    ...started.gate,
    headless: true,
    judge: judgeOf(judge, () => session, "", bus),
  });
  gate.protection = started.protection;
  const tools = TOOLS.map((t) => (t === shellTool ? started.shellTool : t));
  const { root, executor, workspace } = started;
  const session: Session = new Session({ lead, tools, system: started.system, ctx: { root, executor, workspace, gate }, bus });
  return session;
}

const allow = (): Turn => reply('{"allow": true}');

afterEach(() => vi.unstubAllEnvs());

// No time limit, as in executor.test.ts (choice 81).
describe("a session in the box with live link, in real Docker", { timeout: 0 }, () => {
  it("runs the model's command in the box, writing the file in the host's folder, with /work in the system prompt", async (ctx) => {
    const w = world();
    onTestFinished(() => removeTree(w.dir));
    execFileSync(onPath("git", w.env)!, ["init", "-q"], { cwd: w.root, env: w.env, windowsHide: true });
    const started = await launch(ctx, w);
    const lead = new Recording("lead", [callTool("c1", "shell", { command: "echo hi > a.txt" }), reply("done")]);
    await headless(started, lead, new FakeProvider("judge", [allow()])).send("make a.txt", AbortSignal.timeout(600_000));
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("hi\n");
    expect(lead.systems[0]).toContain("The project root is /work.");
    expect(lead.systems[0]).toContain("Shell commands run with bash on linux.");
  });

  // Choice 21. The image has no curl, and the network is off: the command fails either way, and the line says why a
  // network command would. example.invalid is a name that never resolves (RFC 2606), so nothing could leave in any case.
  it("adds the network line to a failed command's result", async (ctx) => {
    const w = world();
    onTestFinished(() => removeTree(w.dir));
    const started = await launch(ctx, w);
    const lead = new FakeProvider("lead", [callTool("c1", "shell", { command: "curl -sS http://example.invalid/" }), reply("done")]);
    const session = headless(started, lead, new FakeProvider("judge", [allow()]));
    await session.send("fetch it", AbortSignal.timeout(600_000));
    const result = session.messages.flatMap((m) => m.parts).find((p) => p.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(result?.type === "tool_result" && result.output).toContain(
      "(The box's network is off, so nothing in it can reach the internet. To allow it, launch with --network on.)",
    );
  });
});
