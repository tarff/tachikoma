import { spawn } from "node:child_process";
import { linkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { LocalWorkspace } from "../../src/exec/local.js";
import { BoxWorkspace, helperCode, LOADER } from "../../src/sandbox/boxWorkspace.js";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { BoxState, DockerExecutor } from "../../src/sandbox/executor.js";
import { removeTree, TREE } from "../helpers.js";

// Runs `node -e <loader>` with its input on the host, as the call would in the box: what node writes, and how it ends.
function node(args: string[], input: Buffer | undefined, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { signal, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.stdin.on("error", () => {}).end(input);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

// The host's Node in place of Docker (choice 69): a call (`exec -i`) runs its loader, the last argument, with the call's
// input; any other docker command (Esc's kill) is recorded and answered with exit 0. No file is written or run, and PATH
// is not changed. `started` is told when a call's node starts.
function hostNode(started?: () => void) {
  const calls: string[][] = [];
  const run: DockerRun = async (args, opts = {}) => {
    calls.push(args);
    if (args[1] !== "-i") return { code: 0, out: "", err: "" };
    const ran = node(["-e", args.at(-1)!], opts.input, opts.signal);
    started?.();
    return ran;
  };
  return { run, calls };
}

// A test folder holding `tree`, each file's folders made, removed when the test ends.
async function folderWith(tree: Record<string, string | Buffer>, prefix = "tachi-helper-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  onTestFinished(() => removeTree(root));
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), text);
  }
  return root;
}

// A link at `link` to the folder `target`: a junction on Windows, which needs no special rights, and a symbolic link
// elsewhere. Skips the test where none can be made.
async function folderLink(ctx: TestContext, target: string, link: string): Promise<void> {
  const made = await symlink(target, link, "junction").then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
      return false;
    },
  );
  if (!made) ctx.skip("this system cannot make a link here without more rights");
}

// The same folder through LocalWorkspace and through the helper, run by the host's Node.
async function both(tree: Record<string, string | Buffer> = TREE) {
  const root = await folderWith(tree);
  return { root, local: new LocalWorkspace(root), box: new BoxWorkspace("box1", hostNode().run, root) };
}

describe("the helper, run by the host's Node, against LocalWorkspace on the same folder", () => {
  it("finds the same files, .gitignore files included", async () => {
    const { local, box } = await both();
    const asked = [[".", "**"], [".", "**/.gitignore"], [".", "src/**/*.ts"], ["src", "**/*.ts"], [".", "**/*.log"], [".", "notes\\*"]] as const;
    for (const [start, pattern] of asked) {
      const want = await local.find(start, pattern);
      expect(await box.find(start, pattern)).toEqual(want);
    }
    // As in a shell, ** leaves out names starting with a dot.
    expect(await box.find(".", "**")).toEqual(["bin.dat", "keep.log", "notes/caf\u00e9.txt", "src/a.ts", "src/b.ts", "src/core/c.ts"]);
    expect(await box.find(".", "**/.gitignore")).toEqual([".gitignore", "src/.gitignore"]);
  });

  it("finds one file given as the start, and none the .gitignore leaves out", async () => {
    const { local, box } = await both();
    expect(await box.find("src/a.ts", "**")).toEqual(await local.find("src/a.ts", "**"));
    expect(await box.find("src/secret.ts", "**")).toEqual([]);
    expect(await local.find("src/secret.ts", "**")).toEqual([]);
  });

  it("searches the same lines: binary files, .git and what .gitignore leaves out skipped", async () => {
    const { local, box } = await both();
    for (const [start, glob] of [[".", undefined], [".", "*.ts"], ["src", "src/**"], ["notes", undefined]] as const) {
      expect(await box.search(start, "match", glob)).toEqual(await local.search(start, "match", glob));
    }
    expect(await box.search(".", "match", undefined)).toEqual({
      matches: [
        { file: "keep.log", line: 1, text: "match kept" },
        { file: "notes/caf\u00e9.txt", line: 1, text: "caf\u00e9 match" },
        { file: "src/b.ts", line: 2, text: "match here" },
        { file: "src/core/c.ts", line: 1, text: "match again" },
      ],
      beyond: 0,
    });
  });

  it("keeps the same output cap and line cut", async () => {
    const many = Array.from({ length: 3000 }, (_, i) => `match number ${i}`).join("\n");
    const { local, box } = await both({ "many.txt": many, "long.txt": `match ${"x".repeat(1500)}` });
    const got = await box.search(".", "match", undefined);
    expect(got).toEqual(await local.search(".", "match", undefined));
    expect(got.beyond).toBeGreaterThan(0);
    expect(got.matches[0]!.text).toBe(`match ${"x".repeat(994)} [cut: 506 more characters]`);
    const size = got.matches.reduce((n, m) => n + `${m.file}:${m.line}: ${m.text}`.length + 1, 0);
    expect(size).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
  });

  it("reads the same text, CRLF and non-ASCII kept", async () => {
    const { root, local, box } = await both();
    for (const p of ["src/b.ts", "notes/caf\u00e9.txt"]) {
      const abs = path.join(root, p);
      expect(await box.readText(abs)).toBe(await local.readText(abs));
    }
    expect(await box.readText(path.join(root, "src/b.ts"))).toBe("line one\r\nmatch here\r\n");
  });

  it("fails a read of a missing file with Node's own words and code", async () => {
    const { root, local, box } = await both();
    const abs = path.join(root, "missing.txt");
    const want = await local.readText(abs).catch((err: NodeJS.ErrnoException) => err);
    await expect(box.readText(abs)).rejects.toMatchObject({ message: (want as Error).message, code: "ENOENT" });
  });

  it("resolves a path to the same place, one not made yet included", async () => {
    const { local, box } = await both();
    for (const p of ["src/a.ts", "src", ".", "new/folder/file.txt"]) {
      const want = await local.resolve(p);
      expect(await box.resolve(p)).toEqual({ ...want, linked: false }); // the box's says whether a file has another name
      expect(want.outside).toBe(false);
    }
  });

  // Task 16: the write tools' check for a file with another name (files.ts, protectedOf) takes it from the box.
  it("says when a file has another name, a hard link", async () => {
    const { root, box } = await both({ "a.txt": "a\n" });
    linkSync(path.join(root, "a.txt"), path.join(root, "b.txt"));
    expect(await box.resolve("b.txt")).toMatchObject({ linked: true });
    expect(await box.resolve("new.txt")).toMatchObject({ linked: false });
  });

  it("reads the same branch, and HEAD for a commit with no branch", async () => {
    const { local, box } = await both();
    expect(await box.branch()).toBe("feature/x");
    expect(await local.branch()).toBe("feature/x");
    const detached = await both({ ".git/HEAD": "0123456789abcdef0123456789abcdef01234567\n" });
    expect(await detached.box.branch()).toBe("HEAD");
    expect(await detached.local.branch()).toBe("HEAD");
  });

  it("reads a worktree's branch from the repository its .git file names", async () => {
    const { local, box } = await both({ ".git": "gitdir: repo/worktrees/w\n", "repo/worktrees/w/HEAD": "ref: refs/heads/side\n" });
    expect(await box.branch()).toBe("side");
    expect(await local.branch()).toBe("side");
  });

  it("writes text, making the parent folders, as LocalWorkspace.writeText does", async () => {
    const { root, box } = await both({});
    await box.writeText(path.join(root, "made/here/new.txt"), "caf\u00e9\r\nnext\n");
    expect(await readFile(path.join(root, "made/here/new.txt"), "utf8")).toBe("caf\u00e9\r\nnext\n");
  });
});

describe("the helper's refusals", () => {
  it("refuses a path that a link leads outside the folder, which LocalWorkspace only marks as outside", async (ctx) => {
    const elsewhere = await folderWith({ "secret.txt": "far away\n" }, "tachi-outside-");
    const { root, local, box } = await both({ "near.txt": "here\n" });
    await folderLink(ctx, elsewhere, path.join(root, "out"));
    const abs = path.join(root, "out", "secret.txt");
    const refused = `${abs} is outside the project, which the sandbox never opens`;
    await expect(box.resolve("out/secret.txt")).rejects.toThrow(refused);
    await expect(box.readText(abs)).rejects.toThrow(refused);
    await expect(box.writeText(abs, "x")).rejects.toThrow(refused);
    await expect(box.find("out", "**")).rejects.toThrow(`${path.join(root, "out")} is outside the project, which the sandbox never opens`);
    expect((await local.resolve("out/secret.txt")).outside).toBe(true);
    expect(await readFile(path.join(elsewhere, "secret.txt"), "utf8")).toBe("far away\n");
  });

  it("refuses a path given outside the folder", async () => {
    const { root, box } = await both({});
    const abs = path.resolve(root, "..", "other.txt");
    await expect(box.resolve("../other.txt")).rejects.toThrow(`${abs} is outside the project, which the sandbox never opens`);
  });

  it("refuses a path through a link that leads nowhere", async (ctx) => {
    const { root, box } = await both({});
    await folderLink(ctx, path.join(root, "gone"), path.join(root, "dangling"));
    const abs = path.join(root, "dangling", "x.txt");
    await expect(box.writeText(abs, "x")).rejects.toThrow(`${abs} goes through a link that leads nowhere, which the sandbox never opens`);
  });
});

describe("a call to the helper", () => {
  it("is docker exec -i of node -e, by bash and setsid, with the code and request on stdin", async () => {
    const root = await folderWith({ "a.txt": "a\n" });
    const fake = hostNode();
    await new BoxWorkspace("box1", fake.run, root).branch();
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.slice(0, 5)).toEqual(["exec", "-i", "box1", "bash", "-c"]);
    expect(call![5]).toMatch(/^exec 3>&2 2>\/dev\/null; setsid -w bash -c 'echo \$\$ > \/tmp\/tachikoma-[0-9a-f-]+; .*exec node -e "\$1"'/);
    expect(call!.slice(6)).toEqual(["_", LOADER]);
  });

  it("sends the group kill on an abort, and rejects with Cancelled", async () => {
    let start!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    const root = await folderWith({ "slow.txt": `${"a".repeat(40)}b\n` });
    const fake = hostNode(() => start());
    const stop = new AbortController();
    // A pattern that takes practically forever on that line.
    const searching = new BoxWorkspace("box1", fake.run, root).search(".", "^(a+)+$", undefined, stop.signal);
    await started;
    stop.abort();
    await expect(searching).rejects.toThrow("Cancelled");
    const group = /> (\/tmp\/tachikoma-[0-9a-f-]+);/.exec(fake.calls[0]![5]!)![1];
    expect(fake.calls[1]).toEqual(["exec", "box1", "bash", "-c", `touch ${group}.stop; kill -KILL -- -"$(cat ${group} 2>/dev/null)" 2>/dev/null; exit 0`]);
  });

  it("does not start once aborted", async () => {
    const fake = hostNode();
    await expect(new BoxWorkspace("box1", fake.run, "/work").search(".", "a", undefined, AbortSignal.abort())).rejects.toThrow("Cancelled");
    expect(fake.calls).toEqual([]);
  });

  // The box's one stopped state (Task 16), in the executor's words, as both now share it.
  it("says when Docker fails, in its words, as the shell does", async () => {
    const run: DockerRun = async () => ({ code: 1, out: "", err: "Error response from daemon: container box1 is not running\n" });
    await expect(new BoxWorkspace("box1", run).branch()).rejects.toThrow(
      "The sandbox stopped working: Error response from daemon: container box1 is not running. Shell and file tools are off until Tachikoma is launched again.",
    );
    await expect(new BoxWorkspace("box1", async () => "missing").branch()).rejects.toThrow(
      "The sandbox stopped working: no docker program is on PATH any more. Shell and file tools are off until Tachikoma is launched again.",
    );
  });
});

// Choice 106: an answer that is not JSON asks Docker whether the box still runs; while it runs only that call fails, and
// only a box or Docker gone turns the shell and file tools off. Docker is a stand-in that records its calls.
describe("a helper answer that is not JSON (choice 106)", () => {
  const LIMITS = { memory: 512 * 2 ** 20, cpus: 1, pids: 64 };
  const ok = (out = "") => ({ code: 0, out, err: "" });
  // `call` answers each helper call in turn; the box runs while `running` says so, with `kills` memory kills counted.
  function stand(call: () => { code: number; out: string; err: string }, box: { running?: boolean; kills?: number } = {}) {
    const calls: string[][] = [];
    const run: DockerRun = async (args) => {
      calls.push(args);
      if (args[0] === "run") return ok("box1\n");
      if (args.includes("{{.State.Running}}")) return ok(`${box.running ?? true}\n`);
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok(`oom_kill ${box.kills ?? 0}\n`);
      if (args[1] === "-i") return call();
      return ok();
    };
    return { run, calls, box };
  }
  const answer = (ok: unknown) => ({ code: 0, out: JSON.stringify({ ok }), err: "" });
  const stopped = (words: string) => `The sandbox stopped working: ${words}. Shell and file tools are off until Tachikoma is launched again.`;

  it("fails only that call while the box runs, in the helper's words, and the tools stay on", async () => {
    const answers = [{ code: 1, out: "", err: "Segmentation fault\n" }, answer("main")];
    const fake = stand(() => answers.shift()!);
    const state = new BoxState("box1", fake.run, LIMITS);
    state.oomKills = 0;
    const ws = new BoxWorkspace("box1", fake.run, "/work", state);
    await expect(ws.branch()).rejects.toThrow(/^The file tool stopped in the box before it answered: Segmentation fault\.$/);
    expect(state.broken).toBeUndefined();
    expect(await ws.branch()).toBe("main");
  });

  it("names the memory limit when the box's memory-kill count rose, as the shell's out-of-memory line does", async () => {
    const fake = stand(() => ({ code: 137, out: "", err: "" }), { kills: 1 });
    const state = new BoxState("box1", fake.run, LIMITS);
    state.oomKills = 0;
    await expect(new BoxWorkspace("box1", fake.run, "/work", state).find(".", "**")).rejects.toThrow(
      'The file tool stopped in the box before it answered: it used more than the box\'s memory limit of 512m. "sandboxLimits" in settings.json changes it.',
    );
    expect(state.broken).toBeUndefined();
  });

  it("gives the exit code when the helper says nothing", async () => {
    const fake = stand(() => ({ code: 3, out: "", err: "" }));
    await expect(new BoxWorkspace("box1", fake.run, "/work", new BoxState("box1", fake.run, LIMITS)).branch()).rejects.toThrow(
      "The file tool stopped in the box before it answered: exit code 3.",
    );
  });

  it("turns the shell and file tools off when the box is gone, and the shell then refuses without Docker", async () => {
    const fake = stand(() => ({ code: 137, out: "", err: "" }), { running: true });
    const box = await DockerExecutor.start(
      { image: "tachikoma-sandbox:0123456789ab", folder: os.tmpdir(), network: "off", limits: LIMITS, mounts: [], session: "s1", user: "1000:1000" },
      fake.run,
    );
    // Removed through the stand-in at once, so a failed assertion cannot leave the exit handler a real `docker rm -f`.
    onTestFinished(() => box.stop());
    const ws = new BoxWorkspace(box.id, fake.run, "/work", box.state);
    fake.box.running = false;
    await expect(ws.readText("/work/a.txt")).rejects.toThrow(stopped("the box stopped"));
    const made = fake.calls.length;
    await expect(box.exec("echo hi", "/work")).rejects.toThrow(stopped("the box stopped"));
    await expect(ws.readText("/work/a.txt")).rejects.toThrow(stopped("the box stopped"));
    expect(fake.calls.length).toBe(made);
  });

  // Task 14's review: the branch is read after every turn, so under the stopped state it is not read, and stays as shown.
  it("gives the branch last read while the tools are off, without Docker", async () => {
    const answers = [answer("main"), { code: 1, out: "", err: "" }];
    const fake = stand(() => answers.shift()!);
    const state = new BoxState("box1", fake.run, LIMITS);
    const ws = new BoxWorkspace("box1", fake.run, "/work", state);
    expect(await ws.branch()).toBe("main");
    fake.box.running = false;
    await expect(ws.readText("/work/a.txt")).rejects.toThrow(stopped("the box stopped"));
    const made = fake.calls.length;
    expect(await ws.branch()).toBe("main");
    expect(fake.calls.length).toBe(made);
  });
});

// The helper is sent as its function's own source. These run that source as tsx (dev) and tsc (the built package) give
// it, beside Vitest's, which every test above runs: tsx names each inner function with a `__name` call of its own.
describe("the helper's text", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const ask = async (code: string, root: string) => {
    const got = await node(["-e", LOADER], Buffer.from(JSON.stringify({ code, request: { op: "find", root, path: ".", pattern: "**" } })));
    return JSON.parse(got.out);
  };

  it("runs as tsx gives it", { timeout: 0 }, async () => {
    const root = await folderWith({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    const tsx = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
    const script = 'import { helperCode } from "./src/sandbox/boxWorkspace.ts"; process.stdout.write(helperCode());';
    const printed = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [tsx, "-e", script], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });
    expect(printed).toContain("__name(");
    expect(await ask(printed, root)).toEqual({ ok: ["a.txt", "sub/b.txt"] });
  });

  it("runs as tsc builds it", { timeout: 0 }, async () => {
    const root = await folderWith({ "a.txt": "a\n", "sub/b.txt": "b\n" });
    const out = await folderWith({ "package.json": '{ "type": "module" }' }, "tachi-built-");
    const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
    // tsconfig.json's options, as the build (tsconfig.build.json) takes them; a file given by name needs --ignoreConfig.
    const flags = ["--ignoreConfig", "--outDir", out, "--target", "es2023", "--module", "nodenext", "--moduleResolution", "nodenext", "--strict"];
    flags.push("--noUncheckedIndexedAccess", "--verbatimModuleSyntax", "--skipLibCheck", "--types", "node");
    const built = await node([tsc, path.join(ROOT, "src/sandbox/helper.ts"), ...flags], undefined);
    expect(built).toMatchObject({ code: 0 });
    const { helper } = await import(pathToFileURL(path.join(out, "helper.js")).href);
    expect(await ask(helperCode(String(helper)), root)).toEqual({ ok: ["a.txt", "sub/b.txt"] });
  });
});
