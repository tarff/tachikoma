import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, type TestContext, vi } from "vitest";
import { sandboxReady, sandboxStart, type Started } from "../../src/clilib.js";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { onPath } from "../../src/exec/env.js";
import { gitSettings } from "../../src/safety/gitconfig.js";
import { dockerState } from "../../src/sandbox/docker.js";
import { boxLimits, dockerRoom } from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import { TOOLS } from "../../src/tools/index.js";
import { shellTool } from "../../src/tools/shell.js";
import { Bus, callTool, FakeProvider, removeTree, reply } from "../helpers.js";

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// The variables a test sets itself, so the user's own never reach git: as in tests/sandbox/session.test.ts.
const OWN = /^(path|home|homedrive|homepath|userprofile|xdg_config_home|git_.*)$/i;

// A test's own folder: a home, empty system and user git settings files, a data folder, where the copy is made, and a
// project holding one made-up file. At the end the box is removed, then the folder, the copy with it.
function world() {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "tachi-copy-")));
  const home = path.join(dir, "home");
  const root = path.join(dir, "project");
  mkdirSync(home);
  mkdirSync(root);
  writeFileSync(path.join(root, "notes.txt"), "made-up notes\n");
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
  const data = path.join(dir, "data");
  vi.stubEnv("TACHI_DATA_DIR", data);
  return { dir, root, env, data };
}

// Copy mode's launch as cli.tsx runs it (clilib.ts), on real Docker with the sandbox's own image (choice 73: never
// pulled, labelled, removed), or a skip with the reason on any Docker the box cannot use. Copy mode is not refused on a
// folder that ignores letter case (choice 104 is live link's), so nothing is injected here.
async function launch(ctx: TestContext, w: ReturnType<typeof world>, session: string): Promise<Started> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
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
  };
  const ready = await sandboxReady(w.root, io, { session });
  if ("exit" in ready) throw new Error(said.join("\n"));
  const started = await sandboxStart(w.root, ready, { network: "off", limits: undefined, session, labels: TEST_LABEL }, io);
  if ("exit" in started) throw new Error(said.join("\n"));
  onTestFinished(() => started.box.stop());
  return started;
}

afterEach(() => vi.unstubAllEnvs());

// No time limit, as in session.test.ts (choice 81).
describe("a session in the box with copy mode, in real Docker", { timeout: 0 }, () => {
  // -p in never, as cli.tsx makes it: the gate headless, nothing asked. The model's write lands in the copy only, and
  // with no review the copy is kept, for `tachi review` (choice 29).
  it("writes the model's file in the copy, never in the folder, and keeps the copy", async (ctx) => {
    const w = world();
    onTestFinished(() => removeTree(w.dir));
    const session = `test-${randomUUID()}`;
    const started = await launch(ctx, w, session);
    const bus = new Bus();
    const gate = new PermissionGate("never", async () => false, "Not allowed in -p mode, where nobody can approve it", { ...started.gate, headless: true });
    gate.protection = started.protection;
    const lead = new FakeProvider("lead", [callTool("c1", "shell", { command: "echo hi > a.txt" }), reply("done")]);
    const tools = TOOLS.map((t) => (t === shellTool ? started.shellTool : t));
    const { root, executor, workspace } = started;
    await new Session({ lead, tools, system: started.system, ctx: { root, executor, workspace, gate }, bus }).send("make a.txt", AbortSignal.timeout(600_000));
    const folder = path.join(w.data, "copies", session);
    expect(readFileSync(path.join(folder, "work", "a.txt"), "utf8")).toBe("hi\n");
    expect(readdirSync(w.root)).toEqual(["notes.txt"]);
    expect(readFileSync(path.join(w.root, "notes.txt"), "utf8")).toBe("made-up notes\n");
    // The box made /work one commit by Tachikoma (choice 24), and the model's file is a change against it.
    const log = await started.box.exec("git log --format='%an <%ae>' && git status --porcelain", "/work");
    expect(log.stdout).toBe("Tachikoma <tachikoma@localhost>\n?? a.txt\n");
    await started.box.stop();
    expect(existsSync(path.join(folder, "manifest.json"))).toBe(true);
    expect(readFileSync(path.join(folder, "base", "notes.txt"), "utf8")).toBe("made-up notes\n");
  });
});

// The user's choice (Task 21's review): the box's repository takes the host's branch, given to git as
// --initial-branch, which git has had since 2.28 (its 2.28.0 release notes); the image's own git is read here.
describe("the box's branch in copy mode, in real Docker", { timeout: 0 }, () => {
  it("takes the host's branch, on an image whose git has --initial-branch", async (ctx) => {
    const w = world();
    onTestFinished(() => removeTree(w.dir));
    const exe = onPath("git", w.env);
    if (!exe) ctx.skip("no git on PATH");
    for (const args of [["init", "-q"], ["symbolic-ref", "HEAD", "refs/heads/feature/made-up"]]) {
      execFileSync(exe!, args, { cwd: w.root, env: w.env, windowsHide: true });
    }
    const started = await launch(ctx, w, `test-${randomUUID()}`);
    const got = await started.box.exec("git --version && git branch --show-current", "/work");
    const [version, branch] = got.stdout.trim().split("\n");
    const [major, minor] = /(\d+)\.(\d+)/.exec(version!)!.slice(1).map(Number) as [number, number];
    expect(major > 2 || (major === 2 && minor >= 28), version).toBe(true);
    expect(branch).toBe("feature/made-up");
  });
});
