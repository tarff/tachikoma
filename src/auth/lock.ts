import { linkSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import path from "node:path";

// One change to the saved login at a time, across every Tachikoma process (release 2 design, "One
// change to the login at a time"). The lock is a file only one process can create, holding that
// process's pid. A waiter wakes when the folder changes, and also every RECHECK_MS, because an owner
// killed outright changes nothing in the folder.

// proper-lockfile's default for refreshing its locks (`update`: half its 10,000 ms `stale`), chosen by
// the user on 2026-10-23. It sets only how long a waiter can sit behind a killed owner.
const RECHECK_MS = 5_000;

const held = new Set<string>();
// Released on every exit Node sees: normal ends, errors, and SIGTERM/SIGHUP, which cli.tsx turns into
// exits. A hard kill leaves the file behind, and the next process takes it over (below).
process.on("exit", () => held.forEach(release));

function unlinkSafe(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

// Removes the lock only while it still holds this process's pid: another process may have taken it
// over in the meantime (see "Known limits").
function release(file: string): void {
  held.delete(file);
  try {
    if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
  } catch {
    // already gone
  }
}

function running(pid: number): boolean {
  if (pid === process.pid) return false; // ours but not held here: left by an earlier process with our pid
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // running, as another user
  }
}

// On Windows a file that is being deleted while another process still has it open cannot be opened
// or made again until that process lets go; the folder changes when it does.
const busy = (err: unknown) => process.platform === "win32" && ["EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "");

// Takes the lock and returns null, or returns the pid holding it (0 while Windows is removing it).
function tryTake(file: string): number | null {
  // The pid is written to a file of this process's own first, then linked in as the lock. Linking
  // fails if the lock exists, and the lock is never seen without its pid.
  const mine = `${file}.${process.pid}`;
  writeFileSync(mine, String(process.pid), { mode: 0o600 });
  try {
    for (;;) {
      try {
        linkSync(mine, file);
        held.add(file);
        return null;
      } catch (err) {
        if (busy(err)) return 0;
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let text: string;
      let made: number;
      try {
        text = readFileSync(file, "utf8");
        made = statSync(file).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // released in between
        if (busy(err)) return 0;
        throw err;
      }
      const pid = Number(text);
      // A lock without a pid was not made by this code, which never leaves one half made: abandoned. So
      // is one made before the computer last started, whatever process has its pid now: it was left by
      // a crash or a power cut.
      const beforeBoot = made < Date.now() - uptime() * 1000;
      if (Number.isInteger(pid) && pid > 0 && running(pid) && !beforeBoot) return pid;
      // Its owner is gone. It is read again just before removal, which narrows, but does not close, the
      // moment in which two waiters could both take it over (see "Known limits").
      try {
        if (readFileSync(file, "utf8") === text) unlinkSync(file);
      } catch {
        // gone already: try again
      }
    }
  } finally {
    unlinkSafe(mine);
  }
}

async function acquire(file: string, onWait: (pid: number) => void, signal?: AbortSignal): Promise<void> {
  const watcher = watch(path.dirname(file));
  try {
    let told = false;
    for (;;) {
      signal?.throwIfAborted();
      // Listening before trying, so a release between the try and the wait is not missed. Only the
      // lock's own changes count: each try makes and removes this process's pid file there too.
      let timer!: NodeJS.Timeout;
      let wake!: (event?: string, name?: string | Buffer | null) => void;
      let stop!: () => void;
      const woken = new Promise<void>((resolve) => {
        wake = (_event, name) => {
          if (!name || name.toString() === path.basename(file)) resolve();
        };
        watcher.on("change", wake);
        timer = setTimeout(resolve, RECHECK_MS);
        stop = () => resolve();
        signal?.addEventListener("abort", stop, { once: true });
      });
      try {
        const holder = tryTake(file);
        if (holder === null) return;
        if (!told && holder > 0) {
          onWait(holder);
          told = true;
        }
        await woken;
      } finally {
        clearTimeout(timer);
        watcher.removeListener("change", wake);
        signal?.removeEventListener("abort", stop);
      }
    }
  } finally {
    watcher.close();
  }
}

// Waits for `before`, or rejects as soon as `signal` is aborted.
function abortable(before: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return before;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void before.then(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
  });
}

// Calls within one process queue here; the lock file is for other processes. Each call's turn ends
// when it does, so a call cancelled while waiting lets the next one go when its own turn comes.
const queues = new Map<string, Promise<void>>();

export function withLock<T>(file: string, fn: () => Promise<T>, onWait: (pid: number) => void = () => {}, signal?: AbortSignal): Promise<T> {
  const before = queues.get(file) ?? Promise.resolve();
  let finished!: () => void;
  const turn = new Promise<void>((resolve) => (finished = resolve));
  queues.set(
    file,
    before.then(() => turn),
  );
  return (async () => {
    try {
      await abortable(before, signal);
      await acquire(file, onWait, signal);
      try {
        return await fn();
      } finally {
        release(file);
      }
    } finally {
      finished();
    }
  })();
}
