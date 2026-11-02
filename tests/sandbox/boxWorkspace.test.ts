import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { LocalWorkspace } from "../../src/exec/local.js";
import { BoxWorkspace } from "../../src/sandbox/boxWorkspace.js";
import { dockerState } from "../../src/sandbox/docker.js";
import { boxLimits, boxUser, DockerExecutor, dockerRoom } from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import { removeTree, TREE } from "../helpers.js";

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// A box from the sandbox's own image (choice 73: never pulled, network off, labelled, removed), on a test folder holding
// `tree`, or a skip with the reason on any Docker the box cannot use. At the end the links made in the box are removed
// there, as the host may not read them as links, then the box, then the folder.
async function realBox(ctx: TestContext, tree: Record<string, string>): Promise<{ box: DockerExecutor; folder: string }> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
  const folder = await mkdtemp(path.join(os.tmpdir(), "tachi-boxws-"));
  let box: DockerExecutor | undefined;
  onTestFinished(async () => {
    await box?.exec("find /work -type l -delete", "/").catch(() => {});
    await box?.stop();
    await removeTree(folder);
  });
  const info = await imageFor(folder);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const space = await dockerRoom();
  const got = boxLimits(undefined, space);
  if (!("limits" in got)) ctx.skip(got.problem);
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(folder, p)), { recursive: true });
    await writeFile(path.join(folder, p), text);
  }
  const opts = { image: info.tag, folder, limits: got.limits, user: boxUser(space), network: "off" } as const;
  box = await DockerExecutor.start({ ...opts, mounts: [], session: `test-${randomUUID()}`, labels: TEST_LABEL });
  return { box, folder };
}

// The box's processes, as `<pid> <command line>` lines, read from /proc: the image has no ps.
const processes = async (box: DockerExecutor) =>
  (await box.exec('for p in /proc/[0-9]*; do echo "${p#/proc/} $(tr "\\0" " " < $p/cmdline)"; done', "/")).stdout;
// A call's node, not a wrapper's command line that names it.
const HELPER = /^\d+ node -e /m;

// No time limit, as in executor.test.ts (choice 81).
describe("BoxWorkspace in real Docker", { timeout: 0 }, () => {
  it("answers on /work as LocalWorkspace does on the host folder", async (ctx) => {
    const { box, folder } = await realBox(ctx, TREE);
    const ws = new BoxWorkspace(box.id);
    const local = new LocalWorkspace(folder);
    expect(ws.root).toBe("/work");
    for (const [start, pattern] of [[".", "**"], [".", "**/.gitignore"], ["src", "**/*.ts"]] as const) {
      expect(await ws.find(start, pattern)).toEqual(await local.find(start, pattern));
    }
    for (const [start, glob] of [[".", undefined], ["src", "*.ts"]] as const) {
      expect(await ws.search(start, "match", glob)).toEqual(await local.search(start, "match", glob));
    }
    expect(await ws.branch()).toBe("feature/x");
    expect(await ws.readText("/work/src/b.ts")).toBe("line one\r\nmatch here\r\n");
    expect(await ws.readText("/work/notes/caf\u00e9.txt")).toBe("caf\u00e9 match\n");
    expect(await ws.resolve("src/a.ts")).toEqual({ abs: "/work/src/a.ts", outside: false, shown: "/work/src/a.ts", real: "/work/src/a.ts" });
    expect(await ws.resolve("new/file.txt")).toEqual({ abs: "/work/new/file.txt", outside: false, shown: "/work/new/file.txt", real: "/work/new/file.txt" });
  });

  it("refuses a link made in the box to /etc", async (ctx) => {
    const { box } = await realBox(ctx, { "a.txt": "a\n" });
    expect((await box.exec("ln -s /etc /work/etc-link", "/work")).code).toBe(0);
    const ws = new BoxWorkspace(box.id);
    const refused = "/work/etc-link/hostname is outside the project, which the sandbox never opens";
    await expect(ws.resolve("etc-link/hostname")).rejects.toThrow(refused);
    await expect(ws.readText("/work/etc-link/hostname")).rejects.toThrow(refused);
    await expect(ws.writeText("/work/etc-link/hostname", "x")).rejects.toThrow(refused);
  });

  it("writes through the box into the host folder, making its folders", async (ctx) => {
    const { box, folder } = await realBox(ctx, {});
    await new BoxWorkspace(box.id).writeText("/work/made/here/new.txt", "caf\u00e9\r\nnext\n");
    expect(await readFile(path.join(folder, "made/here/new.txt"), "utf8")).toBe("caf\u00e9\r\nnext\n");
  });

  it("stops a search on an abort, its node gone from the box", async (ctx) => {
    const { box } = await realBox(ctx, { "slow.txt": `${"a".repeat(40)}b\n` });
    const stop = new AbortController();
    // A pattern that takes practically forever on that line.
    const searching = new BoxWorkspace(box.id).search(".", "^(a+)+$", undefined, stop.signal);
    let settled = false;
    searching.catch(() => {}).finally(() => (settled = true));
    while (!settled && !HELPER.test(await processes(box))) {}
    stop.abort();
    await expect(searching).rejects.toThrow("Cancelled");
    expect(await processes(box)).not.toMatch(HELPER);
  });
});
