// The box: one Docker container per session, where the shell's commands run (release 7 design, "The sandbox"; plan,
// Task 12 and choices 14, 18, 20 and 75-78). Docker is reached only through a DockerRun (choice 69), but for the removal at
// exit, which cannot wait for one.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import os from "node:os";
import { commandEnv, onPath } from "../exec/env.js";
import type { ExecResult, Executor, Running } from "../exec/executor.js";
import { CommandLog } from "../exec/log.js";
import type { SandboxLimits } from "../settings.js";
import { docker, type DockerRun } from "./docker.js";
import type { Mount } from "./mounts.js";

// Memory in bytes, as Docker takes --memory, and CPUs with decimals, as it takes --cpus (choice 75): a default is rounded
// down only to a whole MiB (choice 80) and to 9 decimal places (choice 82).
export interface Limits { memory: number; cpus: number; pids: number }
// `mounts` are live link's (mounts.ts); `user` is boxUser's; `env` are variables every command in the box gets, as live
// link's git settings (choice 100); `labels` are added to the box's own; `unlimited` are the limits Docker cannot apply
// (dockerRoom), whose flags are left out.
export interface BoxOptions {
  image: string;
  folder: string;
  network: "off" | "on";
  limits: Limits;
  mounts: Mount[];
  session: string;
  user: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  unlimited?: Unlimited[];
}
// The limits Docker can be asked for but may not apply (choice 83), as its line names them.
export type Unlimited = "memory" | "CPUs" | "processes";
// What Docker has: its CPUs and its memory in bytes, whether it is rootless, and the limits it cannot apply (`docker
// info`'s NCPU, MemTotal, SecurityOptions, and MemoryLimit, CpuCfsQuota and PidsLimit).
export interface Room { cpus: number; memory: number; rootless: boolean; unlimited: Unlimited[] }

// The launch's line for each limit Docker cannot apply (choice 83). Its flag is left out: Docker drops a memory or
// processes limit it cannot apply with a warning, but refuses to make the box at all with a --cpus it cannot apply
// ("NanoCPUs can not be set"), as rootless Docker cannot by default: it is given memory and processes controls, not CPU.
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
// Docker's least --memory (choice 86): on this PC, 2026-11-02, `docker run --memory 6291455b` gave "Minimum memory limit
// allowed is 6MB", and 6291456b ran.
const DOCKER_MIN_MEMORY = 6 * UNIT.m;

export async function dockerRoom(run: DockerRun = docker): Promise<Room> {
  const got = await run(["info", "--format", "{{json .}}"]);
  const unread = (why: string) => new Error(`The sandbox could not read Docker's CPUs and memory: ${why}`);
  if (got === "missing" || got.code !== 0) throw unread(got === "missing" ? NO_DOCKER : got.err.trim());
  let info: { NCPU?: number; MemTotal?: number; SecurityOptions?: string[] | null; MemoryLimit?: boolean; CpuCfsQuota?: boolean; PidsLimit?: boolean };
  try {
    info = JSON.parse(got.out);
  } catch {
    throw unread("docker info's answer is not JSON");
  }
  const { NCPU, MemTotal } = info;
  if (!(Number.isFinite(NCPU) && NCPU! > 0 && Number.isFinite(MemTotal) && MemTotal! > 0)) {
    throw unread(`docker info gave ${NCPU} CPUs and ${MemTotal} bytes of memory`);
  }
  // Each option is "name=<name>" and its settings, comma-separated: "name=seccomp,profile=builtin".
  const rootless = info.SecurityOptions?.some((o) => o.split(",")[0] === "name=rootless") ?? false;
  // Only a flag that says false is a limit Docker cannot apply; one it does not give is taken as applied.
  const flags = { memory: info.MemoryLimit, CPUs: info.CpuCfsQuota, processes: info.PidsLimit };
  const unlimited = (Object.keys(flags) as Unlimited[]).filter((what) => flags[what] === false);
  return { cpus: NCPU!, memory: MemTotal!, rootless, unlimited };
}

// The limits in force: the user's values as given, the defaults for the rest. A value of the user's above what Docker has
// stops the launch (choice 75), named as written, with Docker's figure in the user's own unit; it may take what a default
// leaves free (choice 76). A default memory under Docker's minimum, with no more than that free to take from or too little
// beyond it, stops it too (choices 76 and 86); a user's value under the minimum is left to Docker's own error.
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
  const share = (of: "memory" | "cpus") => Math.max(BASE[of], (room[of] * BASE[of]) / MEASURED[of]);
  // Down to a whole MiB, so a MemTotal that drifts up by a few KB still gives this PC exactly 4 GiB (choice 80).
  const scaled = Math.floor(Math.min(room.memory - FREE.memory, share("memory")) / UNIT.m) * UNIT.m;
  if (memory === undefined && scaled < DOCKER_MIN_MEMORY) {
    const has = memoryText(room.memory);
    return { problem: `The sandbox needs more than 1 GiB of Docker's memory, and Docker has ${has}. Give Docker more memory, or launch with --sandbox off.` };
  }
  return {
    limits: {
      memory: memory ?? scaled,
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

export const NO_DOCKER = "no docker program is on PATH any more";
// The box's home, which every user can write (choice 77): the dangerous-command check reads `~` in the box as it.
export const BOX_HOME = "/tmp";
// The process space this Tachikoma's pid belongs to, for the box's label (choice 93): the computer's name, which WSL's
// distros share with Windows, its system, and on Linux its pid namespace, which tells two distros or containers apart.
// Where that cannot be read (WSL1, a locked-down /proc), the label goes without it, as this runs at every launch.
const pidSpace = () => {
  try {
    return [readlinkSync("/proc/self/ns/pid")];
  } catch {
    return [];
  }
};
const HOST = [os.hostname(), process.platform, ...(process.platform === "linux" ? pidSpace() : [])].join("/");
// The box's cgroup's memory events, as the box sees them. Only cgroup v2 has the file (Docker Desktop's, and most Linux
// today); cgroup v1, Ubuntu 20.04's and RHEL 8's default, has none, and OOMKilled is read instead (exec, below).
const EVENTS = "/sys/fs/cgroup/memory.events";
// What goes before a line added after a command's output: a line break, unless there is none or it ends with one.
const newline = (text: string) => (text && !text.endsWith("\n") ? "\n" : "");

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

// What the box's executor and its workspace (boxWorkspace.ts) share (release 7 plan, Task 16): one "stopped working"
// state, so once either finds Docker failing the shell and the file tools are both off, and nothing runs on the host; and
// the box's memory-kill count, so either can tell a kill by the memory limit. `limits` is undefined only for a
// workspace a test makes on its own, which then never names the memory limit.
export class BoxState {
  broken: Error | undefined;
  // The box's last count of kills by its memory limit: null when the box has no memory.events (cgroup v1), undefined
  // while it could not be read.
  oomKills: number | null | undefined;

  constructor(
    readonly id: string,
    private readonly run: DockerRun = docker,
    readonly limits?: Limits,
  ) {}

  // From now on every call of either throws the same, and nothing runs, in the box or on the host.
  fail(given: string): Error {
    const words = given || "the box stopped"; // Docker gave none (choice 92)
    const stop = words.endsWith(".") ? "" : ".";
    this.broken = new Error(`The sandbox stopped working: ${words}${stop} Shell and file tools are off until Tachikoma is launched again.`);
    return this.broken;
  }

  // Whether the box still runs: undefined while it does, or Docker's words when it does not (empty when Docker gave none),
  // NO_DOCKER when docker has left PATH.
  async gone(): Promise<string | undefined> {
    const state = await this.run(["inspect", "--format", "{{.State.Running}}", this.id]);
    if (state === "missing") return NO_DOCKER;
    return state.code !== 0 || state.out.trim() !== "true" ? state.err.trim() : undefined;
  }

  // The memory limit's line, for a failure the limit caused.
  memoryLine(): string {
    return `the box's memory limit of ${memoryText(this.limits!.memory)}. "sandboxLimits" in settings.json changes it.`;
  }

  // Whether the box's memory limit killed something since `before`, the count before the command; without one, OOMKilled
  // after a 137 only, as it stays true for the box's life. Nothing read is no.
  async outOfMemory(before: number | null | undefined, code: number): Promise<boolean> {
    if (!this.limits) return false;
    if (typeof before === "number") {
      const now = await this.oomKillCount();
      if (typeof now !== "number") return false;
      this.oomKills = now;
      return now > before;
    }
    if (code !== 137) return false;
    const got = await this.run(["inspect", "--format", "{{.State.OOMKilled}}", this.id]).catch(() => undefined);
    return !!got && got !== "missing" && got.code === 0 && got.out.trim() === "true";
  }

  // The box's count of kills by its memory limit; null when the box has no such file (cgroup v1), in cat's words, so it
  // is not read again before each command; undefined when it could not be read.
  async oomKillCount(): Promise<number | null | undefined> {
    const got = await this.run(["exec", this.id, "cat", EVENTS]).catch(() => undefined);
    if (!got || got === "missing") return undefined;
    if (got.code !== 0) return got.err.includes("No such file or directory") ? null : undefined;
    const count = /^oom_kill (\d+)$/m.exec(got.out)?.[1];
    return count === undefined ? undefined : Number(count);
  }
}

export class DockerExecutor implements Executor {
  readonly state: BoxState;

  private constructor(
    readonly id: string,
    readonly limits: Limits,
    private readonly run: DockerRun,
  ) {
    this.state = new BoxState(id, run, limits);
  }

  // Choice 18's container, never pulled (the image is built here, after asking: image.ts), with no host environment but
  // HOME=/tmp, which every user can write: a Linux user the image does not know has no home (choice 77), and the
  // variables it is given, which `docker exec` passes to each command. Its
  // labels let the next launch find it when this session's process is gone (sweepBoxes): the session, this machine and
  // this process.
  static async start(opts: BoxOptions, run: DockerRun = docker): Promise<DockerExecutor> {
    const { memory, cpus, pids } = opts.limits;
    const unlimited = opts.unlimited ?? [];
    const limit = (what: Unlimited, flags: string[]) => (unlimited.includes(what) ? [] : flags);
    const mounts = opts.mounts.flatMap((m) => ("hidden" in m ? ["--tmpfs", m.box] : ["-v", `${m.host}:${m.box}${m.readOnly ? ":ro" : ""}`]));
    const got = await run([
      "run", "-d", "--pull", "never", "--init", "--user", opts.user, "-e", `HOME=${BOX_HOME}`,
      ...Object.entries(opts.env ?? {}).flatMap(([name, value]) => ["-e", `${name}=${value}`]), "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--network", opts.network === "on" ? "bridge" : "none",
      ...limit("memory", ["--memory", String(memory), "--memory-swap", String(memory)]), ...limit("CPUs", ["--cpus", String(cpus)]),
      ...limit("processes", ["--pids-limit", String(pids)]),
      "-v", `${opts.folder}:/work`, ...mounts, "-w", "/work",
      "--label", `tachikoma.session=${opts.session}`, "--label", `tachikoma.host=${HOST}`, "--label", `tachikoma.pid=${process.pid}`,
      ...Object.entries(opts.labels ?? {}).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
      opts.image, "sleep", "infinity",
    ]);
    if (got === "missing" || got.code !== 0) throw new Error(`The sandbox could not start: ${got === "missing" ? NO_DOCKER : got.err.trim()}`);
    const box = new DockerExecutor(got.out.trim(), opts.limits, run);
    boxes.add(box.id);
    box.state.oomKills = await box.state.oomKillCount();
    return box;
  }

  // `start` plus the signal, as the host's exec is (background commands plan, Task 3): an abort stops the command, and
  // once inGroup's kill has run in the box rejects `Cancelled`, or the sandbox's failure when it could not reach the box
  // (choice 87). A broken box, or an abort before the call, starts nothing.
  async exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (this.state.broken) throw this.state.broken;
    if (signal?.aborted) throw new Error("Cancelled");
    const run = this.start(command, cwd);
    const onAbort = () => run.stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    // start calls the DockerRun before it returns (the count's read), and a run that answers at once, as a test's
    // stand-in does, can abort the signal inside that call, before the listener above was added.
    if (signal?.aborted) run.stop();
    try {
      const r = await run.done;
      if (signal?.aborted) throw new Error("Cancelled"); // even when start gave the real exit code (below)
      return r;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // The command in its own group in the box, each piece it prints going to the log as it arrives (background commands
  // plan, choice 3). A broken box throws here, at once. `stop()` aborts the run's own signal, so inGroup kills the group
  // in the box as for Esc, and `done` gives a kill; a stop while the count is read, before the command reaches the box,
  // starts nothing. Docker's own failures reject `done` with the sandbox's failure, as exec throws it.
  start(command: string, cwd: string): Running {
    const { state } = this;
    if (state.broken) throw state.broken;
    const log = new CommandLog();
    const stopping = new AbortController();
    const { signal } = stopping;
    // Docker's run gives each stream's head only at its end, so a stopped command's `done` has no output; its log has it.
    const killed: ExecResult = { code: null, signal: "SIGKILL", stdout: "", stderr: "" };
    const done = (async (): Promise<ExecResult> => {
      if (state.oomKills === undefined) state.oomKills = await state.oomKillCount(); // again, until it can be read
      if (signal.aborted) return killed; // a stop during that read: nothing has started
      const before = state.oomKills;
      const got = await inGroup(this.run, this.id, ["-w", cwd], "bash -c", command, { signal, cut: true, data: (text) => log.add(text) });
      if ("unreached" in got) throw state.fail(got.unreached);
      if ("cancelled" in got) return killed;
      // A stop during the checks below comes after the command's end: start gives its real exit code, exec Cancelled.
      // A failure may be Docker's own: the box is asked whether it still runs, and if not, Docker's words are given.
      if (got.code !== 0) {
        const gone = await state.gone();
        if (gone === NO_DOCKER) throw state.fail(NO_DOCKER);
        if (gone !== undefined) throw state.fail(got.err.trim() || gone);
      }
      let stderr = got.err;
      // Out of memory, the kernel kills with signal 9: the shell's 137. Measured on 2026-11-02 in a 512 MB box (Docker
      // 29.9.2, cgroup v2): memory.events' oom_kill went up by one at each kill by the memory limit and stayed the same at
      // a plain `kill -9`, while OOMKilled stayed true for the box's life after its first one, so it would blame a later
      // kill -9. So the count is used, read again after every command that fails (choice 89), as a build that exits 2 may
      // hold a process the limit killed, against the count before it: a kill by the limit in a process left running by an
      // earlier command, found after a later failure, is laid on that later one. Without the file (cgroup v1), or for a
      // command whose count before it could not be read, OOMKilled is the only sign, after a 137 only, with that flaw.
      // With background commands running side by side, a long-running command that fails can also be blamed for a kill
      // by the limit in another command started after it: a known limit.
      if (got.code !== 0 && (await state.outOfMemory(before, got.code))) {
        const line = `(Stopped: the command used more than ${state.memoryLine()})`;
        stderr += `${newline(stderr)}${line}`;
        log.add(`${newline(log.kept())}${line}`); // so a background command's ending says it too (choice 3)
      }
      return { code: got.code, signal: null, stdout: got.out, stderr };
    })();
    return { log, done, stop: () => stopping.abort(), stopsLater: true };
  }

  // Removes the box. What it held that is kept lives in /work, a host folder (choice 18). A removal that fails leaves the
  // box to the next launch's sweep.
  async stop(): Promise<void> {
    boxes.delete(this.id);
    await this.run(["rm", "-f", this.id]).catch(() => {});
  }
}

// One docker exec in the box, in a process group of its own, by setsid, whose id the wrapper writes to a file in the box's
// /tmp first, so Esc can kill the whole group in the box (choice 20): `inner` (bash -c, or node -e) runs `arg`. Measured
// on 2026-11-02 (Docker 29.9.2): killing the `docker exec` client of `sleep 600` left the sleep running in the box, so
// killing the client alone is not enough. The outer shell's own reports go to /dev/null (its 2 is moved to 3 for the
// command), as a killed command made it print a "Killed" line quoting the wrapper. An Esc before the id is written leaves
// a `.stop` file, which the wrapper looks for after writing it: Esc writes its file before reading the id, so either it
// reads the id or the wrapper sees its file. `unreached` is Docker's words when the box could not be reached, which
// each caller gives in its own error. DockerExecutor.start (and exec through it) and BoxWorkspace's calls
// (boxWorkspace.ts) run through it; `data` is start's, for its log.
export async function inGroup(
  run: DockerRun,
  id: string,
  flags: string[],
  inner: "bash -c" | "node -e",
  arg: string,
  opts: { signal?: AbortSignal; cut?: boolean; input?: Buffer; data?: (text: string) => void },
): Promise<{ code: number; out: string; err: string } | { cancelled: true } | { unreached: string }> {
  const { signal } = opts;
  const group = `/tmp/tachikoma-${randomUUID()}`;
  const wrapper =
    `exec 3>&2 2>/dev/null; setsid -w bash -c 'echo $$ > ${group}; [ -e ${group}.stop ] && exit; exec ${inner} "$1"' _ "$1" 2>&3 3>&-; ` +
    `s=$?; rm -f ${group} ${group}.stop; exit $s`;
  // Esc's kill ends with exit 0 once it runs in the box, the group gone or not yet made, so a failure is Docker's: its
  // words, or undefined when it reached the box. A kill that cannot reach the box stops the sandbox (choice 87).
  let kill: Promise<string | undefined> | undefined;
  const onAbort = () => {
    const line = `touch ${group}.stop; kill -KILL -- -"$(cat ${group} 2>/dev/null)" 2>/dev/null; exit 0`;
    kill = run(["exec", id, "bash", "-c", line]).then(
      (r) => (r === "missing" ? NO_DOCKER : r.code !== 0 ? r.err.trim() || "the box stopped" : undefined),
      (err: Error) => err.message,
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let got: Awaited<ReturnType<DockerRun>>;
  try {
    got = await run(["exec", ...flags, id, "bash", "-c", wrapper, "_", arg], opts);
  } catch (err) {
    if (signal?.aborted) {
      const unreached = await kill;
      return unreached !== undefined ? { unreached: `Esc could not reach the box (${unreached})` } : { cancelled: true };
    }
    return { unreached: (err as Error).message };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return got === "missing" ? { unreached: NO_DOCKER } : got;
}

// At the launch, before a box starts: removes the boxes of this process space whose Tachikoma process is gone, as one that
// died without its exit handler leaves (killed outright, or the machine stopped). A box of another (another machine on a
// remote Docker, or WSL beside Windows on Docker Desktop's one Docker, with the computer's name but pids of its own), or
// with no labels to tell, is left alone. A process id the system has given to another program reads as alive, so that box
// waits for a later launch.
export async function sweepBoxes(run: DockerRun = docker): Promise<void> {
  const got = await run(["ps", "-a", "--filter", "label=tachikoma.session", "--format", '{{.ID}}\t{{.Label "tachikoma.host"}}\t{{.Label "tachikoma.pid"}}']);
  if (got === "missing" || got.code !== 0) return;
  for (const line of got.out.split("\n")) {
    const [id, host, pid] = line.trim().split("\t");
    if (id && host === HOST && pid && /^\d+$/.test(pid) && !alive(Number(pid))) await run(["rm", "-f", id]);
  }
}

// Whether Docker lists no box of this session any more, by its label (DockerExecutor.start): a copy is reviewed only once
// its box has stopped (release 7 plan, Task 21). With Docker not reachable, no box can be running.
export async function sessionGone(session: string, run: DockerRun = docker): Promise<boolean> {
  const got = await run(["ps", "-a", "-q", "--filter", `label=tachikoma.session=${session}`]).catch(() => "missing" as const);
  return got === "missing" || got.code !== 0 || got.out.trim() === "";
}

// process.kill with signal 0 only asks: ESRCH is no such process, EPERM one that is not ours, but alive. `tachi review`
// asks it too (copies.ts).
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
