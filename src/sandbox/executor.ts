// The box: one Docker container per session, where the shell's commands run (release 7 design, "The sandbox"; plan,
// Task 12 and choices 14, 18, 20 and 75-78). Docker is reached only through a DockerRun (choice 69), but for the removal at
// exit, which cannot wait for one.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { commandEnv, onPath } from "../exec/env.js";
import type { ExecResult, Executor } from "../exec/executor.js";
import type { SandboxLimits } from "../settings.js";
import { docker, type DockerRun } from "./docker.js";

// Memory in bytes, as Docker takes --memory, and CPUs with decimals, as it takes --cpus (choice 75): a default is rounded
// down only to a whole MiB (choice 80) and to 9 decimal places (choice 82).
export interface Limits { memory: number; cpus: number; pids: number }
// Live link's mounts (Task 15 makes them): a host path read-only in the box, or a box path hidden under an empty tmpfs.
export type Mount = { host: string; box: string; readOnly: true } | { box: string; hidden: true };
// `user` is boxUser's; `labels` are added to the box's own.
export interface BoxOptions {
  image: string;
  folder: string;
  network: "off" | "on";
  limits: Limits;
  mounts: Mount[];
  session: string;
  user: string;
  labels?: Record<string, string>;
}
// The limits Docker can be asked for but may not apply (choice 83), as its line names them.
export type Unlimited = "memory" | "CPUs" | "processes";
// What Docker has: its CPUs and its memory in bytes, whether it is rootless, and the limits it cannot apply (`docker
// info`'s NCPU, MemTotal, SecurityOptions, and MemoryLimit, CpuCfsQuota and PidsLimit).
export interface Room { cpus: number; memory: number; rootless: boolean; unlimited: Unlimited[] }

// The launch's line for each limit Docker cannot apply (choice 83). Its flag is still passed.
export const unlimitedLine = (what: Unlimited) => `Docker cannot limit the box's ${what} on this machine, so the box runs without that limit.`;

// Docker reads g and m as 2^30 and 2^20 bytes (measured on 2026-11-02: --memory 1g and 512m gave HostConfig.Memory
// 1073741824 and 536870912).
const UNIT = { g: 2 ** 30, m: 2 ** 20 };
// The defaults (choice 75, the user's "option A", 2026-11-02): 4 GB, 4 CPUs and 1024 processes, Task 1's numbers that the
// user chose on this PC (the plan's Numbers table), scaled by the share of Docker they are here: 4 GB of the
// 33,518,923,776 bytes and 4 of the 24 CPUs `docker info` gave on 2026-11-02. Never below 4 GB and 4 CPUs, never above
// what Docker has. Processes are not scaled: they cost little (the user's choice).
const BASE = { memory: 4 * UNIT.g, cpus: 4, pids: 1024 };
const MEASURED = { memory: 33_518_923_776, cpus: 24 };
// What a default leaves free for Docker itself (choice 76): 1 GiB of memory, Docker's own use while idle read in three
// boxes on 2026-11-02 (MemTotal less MemAvailable, at most 972,532 kB) rounded up, and 1 CPU when it has more than one,
// the user's choice.
const FREE = { memory: UNIT.g, cpus: 1 };

export async function dockerRoom(run: DockerRun = docker): Promise<Room> {
  const got = await run(["info", "--format", "{{json .}}"]);
  if (got === "missing" || got.code !== 0) {
    throw new Error(`The sandbox could not read Docker's CPUs and memory: ${got === "missing" ? NO_DOCKER : got.err.trim()}`);
  }
  const info = JSON.parse(got.out) as {
    NCPU: number;
    MemTotal: number;
    SecurityOptions?: string[] | null;
    MemoryLimit?: boolean;
    CpuCfsQuota?: boolean;
    PidsLimit?: boolean;
  };
  // Each option is "name=<name>" and its settings, comma-separated: "name=seccomp,profile=builtin".
  const rootless = info.SecurityOptions?.some((o) => o.split(",")[0] === "name=rootless") ?? false;
  // Only a flag that says false is a limit Docker cannot apply; one it does not give is taken as applied.
  const flags = { memory: info.MemoryLimit, CPUs: info.CpuCfsQuota, processes: info.PidsLimit };
  const unlimited = (Object.keys(flags) as Unlimited[]).filter((what) => flags[what] === false);
  return { cpus: info.NCPU, memory: info.MemTotal, rootless, unlimited };
}

// The limits in force: the user's values as given, the defaults for the rest. A value of the user's above what Docker has
// stops the launch (choice 75), named as written, with Docker's figure in the user's own unit; it may take what a default
// leaves free (choice 76). A default memory with no more than that free to take from stops it too.
export function boxLimits(set: SandboxLimits | undefined, room: Room): { limits: Limits } | { problem: string } {
  const above = (name: string, value: unknown, has: string) => ({
    problem:
      `settings.json: "sandboxLimits": "${name}" is ${JSON.stringify(value)}, but Docker has ${has}. ` +
      "Lower it, or give Docker more memory or CPUs.", // choice 78
  });
  const unit = set?.memory?.at(-1) as "g" | "m" | undefined;
  const memory = set?.memory && unit ? Number(set.memory.slice(0, -1)) * UNIT[unit] : undefined;
  if (memory !== undefined && memory > room.memory) return above("memory", set!.memory, `${memoryText(room.memory, unit)} of memory`);
  if (set?.cpus !== undefined && set.cpus > room.cpus) return above("cpus", set.cpus, `${room.cpus} CPUs`);
  if (memory === undefined && room.memory <= FREE.memory) {
    const has = memoryText(room.memory);
    return { problem: `The sandbox needs more than 1 GiB of Docker's memory, and Docker has ${has}. Give Docker more memory, or launch with --sandbox off.` };
  }
  const share = (of: "memory" | "cpus") => Math.max(BASE[of], (room[of] * BASE[of]) / MEASURED[of]);
  return {
    limits: {
      // Down to a whole MiB, so a MemTotal that drifts up by a few KB still gives this PC exactly 4 GiB (choice 80).
      memory: memory ?? Math.floor(Math.min(room.memory - FREE.memory, share("memory")) / UNIT.m) * UNIT.m,
      // Down to 9 decimal places: Docker refuses more ("value is too precise", read 2026-11-02; choice 82).
      cpus: set?.cpus ?? Math.floor(Math.min(room.cpus > 1 ? room.cpus - FREE.cpus : room.cpus, share("cpus")) * 1e9) / 1e9,
      pids: set?.pids ?? BASE.pids,
    },
  };
}

// Memory as the settings file takes it: whole g when it is whole gigabytes, else whole m, never more than it is. Under a
// gigabyte, a g would say 0, so it is m.
export function memoryText(bytes: number, unit: "g" | "m" = bytes % UNIT.g === 0 ? "g" : "m"): string {
  const n = Math.floor(bytes / UNIT[unit]);
  return n === 0 && unit === "g" ? memoryText(bytes, "m") : `${n}${unit}`;
}

const NO_DOCKER = "no docker program is on PATH any more";
// The box's cgroup's memory events, as the box sees them. Only cgroup v2 has the file (Docker Desktop's, and most Linux
// today); cgroup v1, Ubuntu 20.04's and RHEL 8's default, has none, and OOMKilled is read instead (exec, below).
const EVENTS = "/sys/fs/cgroup/memory.events";

// Boxes still to remove when Tachikoma ends. "exit" handlers cannot wait, so this one removal runs docker synchronously,
// by its full path, with the environment commands get, as docker.ts does. cli.tsx's signal handlers end through
// process.exit, so a signal exit runs it too; a crash runs it as well.
const boxes = new Set<string>();
process.on("exit", () => {
  const exe = boxes.size ? onPath("docker") : undefined;
  if (exe) spawnSync(exe, ["rm", "-f", ...boxes], { env: commandEnv(), windowsHide: true, stdio: "ignore" });
});

// Who runs the box, always given, so an image cannot choose. Choice 14: the image's tachi user on Windows and macOS; on
// Linux the host user's own ids, so files written in live link belong to the user. Choice 77: rootless Docker maps the
// box's root to the host user, so there it is 0:0, still with no capabilities and no new privileges.
export function boxUser(room: Room, platform: NodeJS.Platform = process.platform): string {
  if (room.rootless) return "0:0";
  return platform === "linux" ? `${process.getuid!()}:${process.getgid!()}` : "1000:1000";
}

export class DockerExecutor implements Executor {
  #broken: Error | undefined;
  // The box's last count of kills by its memory limit: null when the box has no memory.events (cgroup v1), undefined
  // while it could not be read.
  #oomKills: number | null | undefined;

  private constructor(
    readonly id: string,
    readonly limits: Limits,
    private readonly run: DockerRun,
  ) {}

  // Choice 18's container, never pulled (the image is built here, after asking: image.ts), with no host environment but
  // HOME=/tmp, which every user can write: a Linux user the image does not know has no home (choice 77). Its
  // labels let the next launch find it when this session's process is gone (sweepBoxes): the session, this machine and
  // this process.
  static async start(opts: BoxOptions, run: DockerRun = docker): Promise<DockerExecutor> {
    const { memory, cpus, pids } = opts.limits;
    const mounts = opts.mounts.flatMap((m) => ("hidden" in m ? ["--tmpfs", m.box] : ["-v", `${m.host}:${m.box}:ro`]));
    const got = await run([
      "run", "-d", "--pull", "never", "--init", "--user", opts.user, "-e", "HOME=/tmp", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--network", opts.network === "on" ? "bridge" : "none",
      "--memory", String(memory), "--memory-swap", String(memory), "--cpus", String(cpus), "--pids-limit", String(pids),
      "-v", `${opts.folder}:/work`, ...mounts, "-w", "/work",
      "--label", `tachikoma.session=${opts.session}`, "--label", `tachikoma.host=${os.hostname()}`, "--label", `tachikoma.pid=${process.pid}`,
      ...Object.entries(opts.labels ?? {}).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
      opts.image, "sleep", "infinity",
    ]);
    if (got === "missing" || got.code !== 0) throw new Error(`The sandbox could not start: ${got === "missing" ? NO_DOCKER : got.err.trim()}`);
    const box = new DockerExecutor(got.out.trim(), opts.limits, run);
    boxes.add(box.id);
    box.#oomKills = await box.#oomKillCount();
    return box;
  }

  // Each command runs in a process group of its own, by setsid, whose id the wrapper writes to a file in the box's /tmp
  // first, so Esc can kill the whole group in the box (choice 20). Measured on 2026-11-02 (Docker 29.9.2): killing the
  // `docker exec` client of `sleep 600` left the sleep running in the box, so killing the client alone is not enough.
  // The outer shell's own reports go to /dev/null (its 2 is moved to 3 for the command), as a killed command made it
  // print a "Killed" line quoting the wrapper. An Esc before the id is written leaves a `.stop` file, which the wrapper
  // looks for after writing it: Esc writes its file before reading the id, so either it reads the id or the wrapper
  // sees its file.
  async exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (this.#broken) throw this.#broken;
    if (signal?.aborted) throw new Error("Cancelled");
    if (this.#oomKills === undefined) this.#oomKills = await this.#oomKillCount(); // again, until it can be read
    const before = this.#oomKills;
    const group = `/tmp/tachikoma-${randomUUID()}`;
    const wrapper =
      `exec 3>&2 2>/dev/null; setsid -w bash -c 'echo $$ > ${group}; [ -e ${group}.stop ] && exit; exec bash -c "$1"' _ "$1" 2>&3 3>&-; ` +
      `s=$?; rm -f ${group} ${group}.stop; exit $s`;
    let kill: Promise<unknown> | undefined;
    const onAbort = () => {
      kill = this.run(["exec", this.id, "bash", "-c", `touch ${group}.stop; kill -KILL -- -"$(cat ${group} 2>/dev/null)" 2>/dev/null`]).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let got: Awaited<ReturnType<DockerRun>>;
    try {
      got = await this.run(["exec", "-w", cwd, this.id, "bash", "-c", wrapper, "_", command], { signal, cut: true });
    } catch (err) {
      if (signal?.aborted) {
        await kill;
        throw new Error("Cancelled");
      }
      throw this.#fail((err as Error).message);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (got === "missing") throw this.#fail(NO_DOCKER);
    // A failure may be Docker's own: the box is asked whether it still runs, and if not, Docker's words are given.
    if (got.code !== 0) {
      const state = await this.run(["inspect", "--format", "{{.State.Running}}", this.id]);
      if (state === "missing") throw this.#fail(NO_DOCKER);
      if (state.code !== 0 || state.out.trim() !== "true") throw this.#fail(got.err.trim() || state.err.trim());
    }
    let stderr = got.err;
    // Out of memory, the kernel kills with signal 9: the shell's 137. Measured on 2026-11-02 in a 512 MB box (Docker
    // 29.9.2, cgroup v2): memory.events' oom_kill went up by one at each kill by the memory limit and stayed the same at
    // a plain `kill -9`, while OOMKilled stayed true for the box's life after its first one, so it would blame a later
    // kill -9. So the count is used, read after a 137 only, against the last read: a kill by the limit in a process left
    // running by an earlier command, found after a later 137, is laid on that later one. Without the file (cgroup v1),
    // or for a command whose count before it could not be read, OOMKilled is the only sign, with that flaw.
    if (got.code === 137 && (await this.#outOfMemory(before))) {
      const limit = memoryText(this.limits.memory);
      const line = `(Stopped: the command used more than the box's memory limit of ${limit}. "sandboxLimits" in settings.json changes it.)`;
      stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${line}`;
    }
    return { code: got.code, signal: null, stdout: got.out, stderr };
  }

  // The helper comes with Task 13.
  async readFile(_abs: string): Promise<string> {
    if (this.#broken) throw this.#broken;
    throw new Error("not yet");
  }

  async writeFile(_abs: string, _content: string): Promise<void> {
    if (this.#broken) throw this.#broken;
    throw new Error("not yet");
  }

  // Removes the box. What it held that is kept lives in /work, a host folder (choice 18). A removal that fails leaves the
  // box to the next launch's sweep.
  async stop(): Promise<void> {
    boxes.delete(this.id);
    await this.run(["rm", "-f", this.id]).catch(() => {});
  }

  // From now on every call throws the same, and nothing runs, in the box or on the host.
  #fail(words: string): Error {
    const stop = words.endsWith(".") ? "" : ".";
    this.#broken = new Error(`The sandbox stopped working: ${words}${stop} Shell and file tools are off until Tachikoma is launched again.`);
    return this.#broken;
  }

  // Whether the box's memory limit killed something since `before`, the count before the command. Nothing read is no.
  async #outOfMemory(before: number | null | undefined): Promise<boolean> {
    if (typeof before === "number") {
      const now = await this.#oomKillCount();
      if (typeof now !== "number") return false;
      this.#oomKills = now;
      return now > before;
    }
    const got = await this.run(["inspect", "--format", "{{.State.OOMKilled}}", this.id]).catch(() => undefined);
    return !!got && got !== "missing" && got.code === 0 && got.out.trim() === "true";
  }

  // The box's count of kills by its memory limit; null when the box has no such file (cgroup v1), in cat's words, so it
  // is not read again before each command; undefined when it could not be read.
  async #oomKillCount(): Promise<number | null | undefined> {
    const got = await this.run(["exec", this.id, "cat", EVENTS]).catch(() => undefined);
    if (!got || got === "missing") return undefined;
    if (got.code !== 0) return got.err.includes("No such file or directory") ? null : undefined;
    const count = /^oom_kill (\d+)$/m.exec(got.out)?.[1];
    return count === undefined ? undefined : Number(count);
  }
}

// At the launch, before a box starts: removes the boxes of this machine whose Tachikoma process is gone, as one that died
// without its exit handler leaves (killed outright, or the machine stopped). A box of another machine sharing the Docker
// (a remote Docker, or WSL beside Windows with a host name of its own), or with no labels to tell, is left alone. A
// process id the system has given to another program reads as alive, so that box waits for a later launch.
export async function sweepBoxes(run: DockerRun = docker): Promise<void> {
  const got = await run(["ps", "-a", "--filter", "label=tachikoma.session", "--format", '{{.ID}}\t{{.Label "tachikoma.host"}}\t{{.Label "tachikoma.pid"}}']);
  if (got === "missing" || got.code !== 0) return;
  for (const line of got.out.split("\n")) {
    const [id, host, pid] = line.trim().split("\t");
    if (id && host === os.hostname() && pid && /^\d+$/.test(pid) && !alive(Number(pid))) await run(["rm", "-f", id]);
  }
}

// process.kill with signal 0 only asks: ESRCH is no such process, EPERM one that is not ours, but alive.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
