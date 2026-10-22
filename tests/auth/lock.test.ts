import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withLock } from "../../src/auth/lock.js";

const lockUrl = pathToFileURL(path.resolve("src/auth/lock.ts")).href;

// Runs TypeScript in a separate Node process, as a second Tachikoma would be.
function run(dir: string, name: string, source: string): { done: Promise<number | null>; output: () => string; kill: () => void } {
  const file = path.join(dir, `${name}.mts`);
  writeFileSync(file, `import { withLock } from ${JSON.stringify(lockUrl)};\n${source}`);
  const child = spawn(process.execPath, ["--import", "tsx", file], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  return { done: new Promise((resolve) => child.on("close", resolve)), output: () => out, kill: () => child.kill("SIGKILL") };
}

const tempDir = () => mkdtemp(path.join(tmpdir(), "tachi-lock-"));

describe("withLock", () => {
  it("lets one process at a time in", async () => {
    const dir = await tempDir();
    const lock = JSON.stringify(path.join(dir, "login.lock"));
    const log = JSON.stringify(path.join(dir, "log"));
    const workers = ["a", "b", "c"].map((tag) =>
      run(
        dir,
        tag,
        `import { appendFileSync } from "node:fs";
await withLock(${lock}, async () => {
  appendFileSync(${log}, "${tag} in\\n");
  await new Promise((r) => setTimeout(r, 300));
  appendFileSync(${log}, "${tag} out\\n");
});`,
      ),
    );
    expect(await Promise.all(workers.map((w) => w.done))).toEqual([0, 0, 0]);
    const lines = readFileSync(path.join(dir, "log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) expect(lines[i + 1]).toBe(lines[i]!.replace(" in", " out"));
    expect(existsSync(path.join(dir, "login.lock"))).toBe(false);
  }, 30_000);

  it("queues calls within one process", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const order: string[] = [];
    const step = (tag: string) =>
      withLock(file, async () => {
        order.push(`${tag} in`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${tag} out`);
      });
    await Promise.all([step("a"), step("b")]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);
  });

  it("is released when the work fails", async () => {
    const file = path.join(await tempDir(), "login.lock");
    await expect(withLock(file, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await withLock(file, async () => "next")).toBe("next");
  });

  it("takes over a lock whose owner is no longer running", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("close", r));
    writeFileSync(file, String(gone.pid));
    expect(await withLock(file, async () => "taken")).toBe("taken");
  });

  it("takes over a lock made before the computer last started, whatever process has its pid now", async () => {
    const file = path.join(await tempDir(), "login.lock");
    writeFileSync(file, String(process.ppid)); // running, and not this process
    const boot = Date.now() / 1000 - uptime();
    utimesSync(file, boot - 1, boot - 1);
    let waited = false;
    expect(await withLock(file, async () => "taken", () => (waited = true))).toBe("taken");
    expect(waited).toBe(false);
  });

  // A backup or antivirus program can hold a leftover lock open, so that it cannot be removed yet.
  it.runIf(process.platform === "win32")("waits without blocking while another program holds a leftover lock open", async () => {
    const file = path.join(await tempDir(), "login.lock");
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("close", r));
    writeFileSync(file, String(gone.pid));
    const holder = spawn("powershell.exe", ["-NoProfile", "-Command", `$f = [IO.File]::Open('${file}', 'Open', 'Read', 'Read'); 'open'; Start-Sleep -Seconds 2; $f.Close()`]);
    let out = "";
    holder.stdout.on("data", (d) => (out += d));
    while (!out.includes("open")) await new Promise((r) => setTimeout(r, 20));
    const mine = withLock(file, async () => "taken");
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 100));
    expect(Date.now() - start).toBeLessThan(1_000); // not held up for the program's 2 s
    expect(await mine).toBe("taken");
  }, 30_000);

  it("leaves a lock that another process took over in the meantime", async () => {
    const file = path.join(await tempDir(), "login.lock");
    await withLock(file, async () => writeFileSync(file, String(process.ppid)));
    expect(readFileSync(file, "utf8")).toBe(String(process.ppid));
  });

  it("takes over a lock with no pid in it", async () => {
    const file = path.join(await tempDir(), "login.lock");
    writeFileSync(file, "");
    expect(await withLock(file, async () => "taken")).toBe("taken");
  });

  it("goes on when the owner it waits for is killed outright, which changes nothing in the folder", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    const owner = run(dir, "owner", `await withLock(${JSON.stringify(file)}, async () => {
  console.log("held");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});`);
    while (!owner.output().includes("held")) await new Promise((r) => setTimeout(r, 20));
    let waiting = false;
    const mine = withLock(file, async () => "in", () => (waiting = true));
    while (!waiting) await new Promise((r) => setTimeout(r, 20));
    owner.kill(); // no exit handler runs, so the lock file stays
    await owner.done;
    expect(existsSync(file)).toBe(true);
    expect(await mine).toBe("in");
  }, 30_000);

  it("stops waiting when cancelled, in this process's queue and behind another process", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    let release!: () => void;
    let firstDone = false;
    const first = withLock(file, () => new Promise<void>((r) => (release = r)).then(() => void (firstDone = true)));
    const queued = new AbortController();
    const second = withLock(file, async () => "second", undefined, queued.signal);
    // The cancelled call's place in the queue still waits for the first.
    const third = withLock(file, async () => (firstDone ? "third" : "third, while the first held the lock"));
    queued.abort();
    await expect(second).rejects.toThrow("aborted");
    release();
    await first;
    expect(await third).toBe("third");

    const owner = run(dir, "owner", `await withLock(${JSON.stringify(file)}, async () => {
  console.log("held");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});`);
    while (!owner.output().includes("held")) await new Promise((r) => setTimeout(r, 20));
    const behind = new AbortController();
    let waiting = false;
    const mine = withLock(file, async () => "in", () => (waiting = true), behind.signal);
    while (!waiting) await new Promise((r) => setTimeout(r, 20));
    behind.abort();
    await expect(mine).rejects.toThrow("aborted");
    owner.kill();
    await owner.done;
  }, 30_000);

  it("waits for a running owner, says which, and goes on when it is released", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "login.lock");
    let release!: () => void;
    const first = withLock(file, () => new Promise<void>((r) => (release = r)));
    while (!existsSync(file)) await new Promise((r) => setTimeout(r, 10));
    const other = run(dir, "other", `await withLock(${JSON.stringify(file)}, async () => console.log("got it"), (pid) => console.log("waiting for " + pid));`);
    while (!other.output().includes("waiting")) await new Promise((r) => setTimeout(r, 20));
    expect(other.output().trim()).toBe(`waiting for ${process.pid}`);
    const released = Date.now();
    release();
    await first;
    while (!other.output().includes("got it")) await new Promise((r) => setTimeout(r, 20));
    // Woken by the release itself: the 5 s recheck alone would take most of 5 s here.
    expect(Date.now() - released).toBeLessThan(2_500);
    expect(await other.done).toBe(0);
  }, 30_000);
});
