import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { tryLock, type OsLock } from "../../src/memory/oslock.js";
import { removeTree } from "../helpers.js";

const CHILD = path.resolve("tests/memory/oslock-child.ts");

type Child = ChildProcessByStdio<Writable, Readable, Readable>;

// Everything a test started or took, stopped or let go after it, whether it passed or not.
const children: Child[] = [];
const locks: OsLock[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const lock of locks.splice(0)) lock.release();
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise((resolve) => child.on("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }),
  );
  for (const folder of folders.splice(0)) await removeTree(folder);
});

async function folder(): Promise<string> {
  const made = await mkdtemp(path.join(tmpdir(), "tachi-oslock-"));
  folders.push(made);
  return made;
}

// A second process, as another Tachikoma window would be. `next` gives its next line of output.
function start(mode: "hold" | "warnings", dir: string, name: string) {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD, mode, dir, name], { stdio: "pipe" });
  children.push(child);
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let rest = "";
  let errors = "";
  child.stdout.on("data", (d) => {
    rest += d;
    for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
      const line = rest.slice(0, at).replace(/\r$/, "");
      rest = rest.slice(at + 1);
      const wake = waiting.shift();
      if (wake) wake(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (d) => (errors += d));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    child,
    closed,
    errors: () => errors,
    next: () =>
      lines.length
        ? Promise.resolve(lines.shift()!)
        : new Promise<string>((resolve, reject) => {
            waiting.push(resolve);
            void closed.then((code) => reject(new Error(`exited ${code}; stderr: ${errors}`)));
          }),
  };
}

const take = (dir: string, name: "join" | "install" | "save") => {
  const lock = tryLock(dir, name);
  if (lock) locks.push(lock);
  return lock;
};

describe("tryLock", () => {
  it("is refused while another process holds the lock", async () => {
    const dir = await folder();
    const holder = start("hold", dir, "join");
    expect(await holder.next()).toBe("took");
    expect(take(dir, "join")).toBeNull();
  });

  it("is taken once the holder lets go, while the holder still runs", async () => {
    const dir = await folder();
    const holder = start("hold", dir, "join");
    expect(await holder.next()).toBe("took");
    expect(take(dir, "join")).toBeNull();
    holder.child.stdin.write("release\n");
    expect(await holder.next()).toBe("released");
    expect(holder.child.exitCode).toBeNull();
    expect(take(dir, "join")).not.toBeNull();
  });

  it("is taken once the holder is killed outright", async () => {
    const dir = await folder();
    const holder = start("hold", dir, "save");
    expect(await holder.next()).toBe("took");
    expect(take(dir, "save")).toBeNull();
    holder.child.kill("SIGKILL");
    await holder.closed;
    expect(take(dir, "save")).not.toBeNull();
  });

  it("refuses a second process while this one holds it, and lets it in after", async () => {
    const dir = await folder();
    const lock = take(dir, "install")!;
    expect(lock).not.toBeNull();
    expect(await start("hold", dir, "install").next()).toBe("busy");
    lock.release();
    expect(await start("hold", dir, "install").next()).toBe("took");
  });

  it("does not block a lock of another name", async () => {
    const dir = await folder();
    const holder = start("hold", dir, "join");
    expect(await holder.next()).toBe("took");
    expect(take(dir, "save")).not.toBeNull();
    expect(take(dir, "install")).not.toBeNull();
    expect(take(dir, "join")).toBeNull();
  });

  it("loads node:sqlite at the first take, dropping only its experimental warning", async () => {
    const dir = await folder();
    const child = start("warnings", dir, "join");
    expect(await child.next()).toBe("loaded");
    expect(await child.next()).toBe("took");
    expect(await child.closed).toBe(0);
    expect(child.errors()).not.toContain("SQLite is an experimental feature");
    expect(child.errors()).toContain("ExperimentalWarning: another warning, still shown");
  });
});
