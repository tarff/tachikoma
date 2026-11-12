import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readlinkSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, type TestContext, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { docker, type DockerRun, dockerState } from "../../src/sandbox/docker.js";
import {
  type BoxOptions,
  boxLimits,
  boxUser,
  DockerExecutor,
  dockerRoom,
  type Limits,
  sweepBoxes,
  type Unlimited,
  unlimitedLine,
} from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";

type Answer = Awaited<ReturnType<DockerRun>>;
const ok = (out = ""): Answer => ({ code: 0, out, err: "" });

// A stand-in for Docker (release 7 plan, choice 69): it records each call's arguments and answers by them. No file is
// written or run, and PATH is not changed.
function fakeDocker(answer: (args: string[]) => Answer) {
  const calls: string[][] = [];
  const options: Parameters<DockerRun>[1][] = [];
  const run: DockerRun = async (args, opts) => {
    calls.push(args);
    options.push(opts);
    return answer(args);
  };
  return { run, calls, options };
}

const GB = 2 ** 30;
const MB = 2 ** 20;
// What `docker info --format {{json .}}` gives, the parts read, for the worked examples of choices 75 and 76. The
// security options and the three limits' flags are this PC's, 2026-11-02.
const DESKTOP = ["name=seccomp,profile=builtin", "name=cgroupns"];
const info = (cpus: number, memory: number, more: Record<string, unknown> = {}) =>
  JSON.stringify({ NCPU: cpus, MemTotal: memory, SecurityOptions: DESKTOP, MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true, ...more });
const THIS_PC = info(24, 33518923776);
const room = async (answer: string) => dockerRoom(fakeDocker(() => ok(`${answer}\n`)).run);
// The process space this test runs in, as choice 93 names it.
const HOST = [os.hostname(), process.platform, ...(process.platform === "linux" ? [readlinkSync("/proc/self/ns/pid")] : [])].join("/");
const OPTS: BoxOptions = {
  image: "tachikoma-sandbox:0123456789ab",
  folder: path.join(os.tmpdir(), "project"),
  network: "off",
  limits: { memory: 4 * GB, cpus: 4, pids: 1024 },
  mounts: [],
  session: "s1",
  user: "1000:1000",
};

describe("the box's limits (choices 75, 76, 80, 82 and 83)", () => {
  it("reads Docker's CPUs, memory, security options and the limits it can apply from one docker info", async () => {
    const fake = fakeDocker(() => ok(`${THIS_PC}\n`));
    expect(await dockerRoom(fake.run)).toEqual({ cpus: 24, memory: 33518923776, rootless: false, unlimited: [] });
    expect(fake.calls).toEqual([["info", "--format", "{{json .}}"]]);
  });

  it("says which limits Docker cannot apply, each in its own line (choice 83)", async () => {
    expect((await room(info(4, 8 * GB, { MemoryLimit: false, PidsLimit: false }))).unlimited).toEqual(["memory", "processes"]);
    expect((await room(info(4, 8 * GB, { CpuCfsQuota: false }))).unlimited).toEqual(["CPUs"]);
    expect(unlimitedLine("memory")).toBe("Docker cannot limit the box's memory on this machine, so the box runs without that limit.");
    expect(unlimitedLine("CPUs")).toBe("Docker cannot limit the box's CPUs on this machine, so the box runs without that limit.");
    expect(unlimitedLine("processes")).toBe("Docker cannot limit the box's processes on this machine, so the box runs without that limit.");
  });

  it("still works out a limit Docker cannot apply (choice 83)", async () => {
    const space = await room(info(24, 33518923776, { MemoryLimit: false, CpuCfsQuota: false, PidsLimit: false }));
    expect(boxLimits(undefined, space)).toEqual({ limits: { memory: 4 * GB, cpus: 4, pids: 1024 } });
  });

  // Docker refuses to make a box with --cpus where it cannot apply it ("NanoCPUs can not be set"), as rootless Docker
  // does by default, so each limit it cannot apply has its flags left out.
  it("leaves out of docker run the flags of each limit Docker cannot apply (choice 83)", async () => {
    const flags = async (unlimited: Unlimited[]) => {
      const fake = fakeDocker((args) => ok(args[0] === "run" ? "b0x\n" : "oom_kill 0\n"));
      await (await DockerExecutor.start({ ...OPTS, unlimited }, fake.run)).stop();
      return fake.calls[0]!.filter((a) => ["--memory", "--memory-swap", "--cpus", "--pids-limit"].includes(a));
    };
    expect(await flags([])).toEqual(["--memory", "--memory-swap", "--cpus", "--pids-limit"]);
    expect(await flags(["CPUs"])).toEqual(["--memory", "--memory-swap", "--pids-limit"]);
    expect(await flags(["memory"])).toEqual(["--cpus", "--pids-limit"]);
    expect(await flags(["processes"])).toEqual(["--memory", "--memory-swap", "--cpus"]);
    expect(await flags(["memory", "CPUs", "processes"])).toEqual([]);
  });

  it("says so when docker info's answer is not JSON, or has no CPUs or memory", async () => {
    await expect(room("Client: Docker Engine")).rejects.toThrow("The sandbox could not read Docker's CPUs and memory: ");
    await expect(room(JSON.stringify({ MemTotal: 8 * GB }))).rejects.toThrow("The sandbox could not read Docker's CPUs and memory: ");
    await expect(room(JSON.stringify({ NCPU: 0, MemTotal: 8 * GB }))).rejects.toThrow("The sandbox could not read Docker's CPUs and memory: ");
  });

  it("says so when docker info fails", async () => {
    const fake = fakeDocker(() => ({ code: 1, out: "", err: "error during connect: the pipe is gone\n" }));
    await expect(dockerRoom(fake.run)).rejects.toThrow("The sandbox could not read Docker's CPUs and memory: error during connect: the pipe is gone");
  });

  it("keeps 4 GB and 4 CPUs on this PC, and 1024 processes", async () => {
    expect(boxLimits(undefined, await room(THIS_PC))).toEqual({ limits: { memory: 4 * GB, cpus: 4, pids: 1024 } });
  });

  it("leaves 1 GiB and 1 CPU free on a 2 GiB, 2-CPU Docker, and still gives 1024 processes", async () => {
    expect(boxLimits(undefined, await room(info(2, 2 * GB)))).toEqual({ limits: { memory: 1 * GB, cpus: 1, pids: 1024 } });
  });

  it("gives a 1-CPU Docker its one CPU", async () => {
    expect(boxLimits(undefined, await room(info(1, 8 * GB)))).toEqual({ limits: { memory: 4 * GB, cpus: 1, pids: 1024 } });
  });

  it("stops when Docker has no more than the 1 GiB it keeps free", async () => {
    const stop = (has: string) =>
      `The sandbox needs more than 1 GiB of Docker's memory, and Docker has ${has}. Give Docker more memory, or launch with --sandbox off.`;
    expect(boxLimits(undefined, await room(info(2, 1 * GB)))).toEqual({ problem: stop("1g") });
    expect(boxLimits(undefined, await room(info(2, 900 * MB)))).toEqual({ problem: stop("900m") });
  });

  it("stops when what is left is under Docker's 6 MiB minimum, and gives exactly 6 MiB at it (choice 86)", async () => {
    const stop = (has: string) =>
      `The sandbox needs more than 1 GiB of Docker's memory, and Docker has ${has}. Give Docker more memory, or launch with --sandbox off.`;
    expect(boxLimits(undefined, await room(info(2, 1 * GB + 1)))).toEqual({ problem: stop("1024m") });
    expect(boxLimits(undefined, await room(info(2, 1 * GB + 5 * MB)))).toEqual({ problem: stop("1029m") });
    expect(boxLimits(undefined, await room(info(2, 1 * GB + 6 * MB)))).toEqual({ limits: { memory: 6 * MB, cpus: 1, pids: 1024 } });
  });

  it("scales up on a 128 GB, 64-CPU Docker: memory down to a whole MiB, CPUs down to 9 decimal places", async () => {
    const got = boxLimits(undefined, await room(info(64, 128 * GB)));
    expect(got).toEqual({ limits: { memory: Math.floor((128 * GB * 4 * GB) / 33518923776 / MB) * MB, cpus: 10.666666666, pids: 1024 } });
    if (!("limits" in got)) return;
    expect(got.limits.memory / GB).toBeCloseTo(16.4, 1);
  });

  it("gives this PC exactly 4 GiB when its MemTotal drifts up a few KB (choice 80)", async () => {
    expect(boxLimits(undefined, await room(info(24, 33518931968)))).toEqual({ limits: { memory: 4 * GB, cpus: 4, pids: 1024 } });
  });

  it("never gives docker run a --cpus with more than 9 decimal places, which Docker refuses (choice 82)", async () => {
    for (const cpus of [28, 32, 64, 100, 128]) {
      const got = boxLimits(undefined, await room(info(cpus, 256 * GB)));
      if (!("limits" in got)) throw new Error(got.problem);
      const fake = fakeDocker((args) => ok(args[0] === "run" ? "b0x\n" : "oom_kill 0\n"));
      await (await DockerExecutor.start({ ...OPTS, limits: got.limits }, fake.run)).stop();
      const run = fake.calls[0]!;
      expect(run[run.indexOf("--cpus") + 1]).toMatch(/^\d+(\.\d{1,9})?$/);
    }
  });

  it("uses the user's values as given when they fit, defaults for the rest", async () => {
    expect(boxLimits({ memory: "8g", cpus: 1.5 }, await room(THIS_PC))).toEqual({ limits: { memory: 8 * GB, cpus: 1.5, pids: 1024 } });
    expect(boxLimits({ memory: "512m", pids: 5000 }, await room(THIS_PC))).toEqual({ limits: { memory: 512 * MB, cpus: 4, pids: 5000 } });
    // All of Docker's memory and CPUs fit: the user may take what a default leaves free (choice 76).
    expect(boxLimits({ cpus: 24 }, await room(THIS_PC))).toEqual({ limits: { memory: 4 * GB, cpus: 24, pids: 1024 } });
    expect(boxLimits({ memory: "2g", cpus: 2 }, await room(info(2, 2 * GB)))).toEqual({ limits: { memory: 2 * GB, cpus: 2, pids: 1024 } });
    expect(boxLimits({ memory: "512m" }, await room(info(2, 900 * MB)))).toEqual({ limits: { memory: 512 * MB, cpus: 1, pids: 1024 } });
  });

  it("refuses a user's value above what Docker has, naming the entry and Docker's figure in the user's own unit", async () => {
    const after = "Lower it, or give Docker more memory or CPUs."; // choice 78
    expect(boxLimits({ cpus: 32 }, await room(THIS_PC))).toEqual({
      problem: `settings.json: "sandboxLimits": "cpus" is 32, but Docker has 24 CPUs. ${after}`,
    });
    expect(boxLimits({ memory: "64g" }, await room(THIS_PC))).toEqual({
      problem: `settings.json: "sandboxLimits": "memory" is "64g", but Docker has 31g of memory. ${after}`,
    });
    expect(boxLimits({ memory: "40000m" }, await room(THIS_PC))).toEqual({
      problem: `settings.json: "sandboxLimits": "memory" is "40000m", but Docker has 31966m of memory. ${after}`,
    });
    // Under a whole gigabyte, Docker's memory is said in megabytes.
    expect(boxLimits({ memory: "1g" }, await room(info(2, 900 * MB)))).toEqual({
      problem: `settings.json: "sandboxLimits": "memory" is "1g", but Docker has 900m of memory. ${after}`,
    });
  });
});

describe("boxUser (choices 14 and 77)", () => {
  it("is 0:0 for rootless Docker, which maps the box's root to the host user", async () => {
    const rootless = await room(info(4, 8 * GB, { SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"] }));
    expect(rootless.rootless).toBe(true);
    for (const platform of ["linux", "darwin", "win32"] as const) expect(boxUser(rootless, platform)).toBe("0:0");
  });

  it("is the image's 1000:1000 on Windows and macOS, and the host user's own ids on Linux", async () => {
    const desktop = await room(THIS_PC);
    expect(boxUser(desktop, "win32")).toBe("1000:1000");
    expect(boxUser(desktop, "darwin")).toBe("1000:1000");
    if (process.platform === "linux") expect(boxUser(desktop, "linux")).toBe(`${process.getuid!()}:${process.getgid!()}`);
  });
});

describe("DockerExecutor with a stand-in Docker", () => {
  const EVENTS = "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n";
  const answering = (exec: (args: string[]) => Answer) =>
    fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args[0] === "exec" && args.includes("/sys/fs/cgroup/memory.events")) return ok(EVENTS);
      if (args[0] === "exec") return exec(args);
      if (args[0] === "inspect") return ok("true\n");
      return ok();
    });

  it("starts the box as choice 18 says, with labels to find it by, live link's mounts after the project's", async () => {
    const fake = answering(() => ok());
    const mounts = [
      { host: path.join(OPTS.folder, "web"), box: "/work/web", readOnly: false },
      { host: path.join(OPTS.folder, ".git"), box: "/work/.git", readOnly: true },
      { box: "/work/.tachikoma", hidden: true as const },
    ];
    const box = await DockerExecutor.start({ ...OPTS, mounts }, fake.run);
    expect(fake.calls[0]).toEqual([
      "run", "-d", "--pull", "never", "--init", "--user", "1000:1000", "-e", "HOME=/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--network", "none", "--memory", String(4 * GB), "--memory-swap", String(4 * GB), "--cpus", "4", "--pids-limit", "1024",
      "-v", `${OPTS.folder}:/work`, "-v", `${path.join(OPTS.folder, "web")}:/work/web`, "-v", `${path.join(OPTS.folder, ".git")}:/work/.git:ro`,
      "--tmpfs", "/work/.tachikoma", "-w", "/work",
      "--label", "tachikoma.session=s1", "--label", `tachikoma.host=${HOST}`, "--label", `tachikoma.pid=${process.pid}`,
      OPTS.image, "sleep", "infinity",
    ]);
    expect(fake.calls[1]).toEqual(["exec", "b0x", "cat", "/sys/fs/cgroup/memory.events"]);
    await box.stop();
    expect(fake.calls.at(-1)).toEqual(["rm", "-f", "b0x"]);
  });

  it("gives the box the variables it is given, after HOME, so every docker exec has them (choice 100)", async () => {
    const fake = answering(() => ok());
    await (await DockerExecutor.start({ ...OPTS, env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "" } }, fake.run)).stop();
    const run = fake.calls[0]!;
    const home = run.indexOf("HOME=/tmp");
    expect(run.slice(home + 1, home + 7)).toEqual(["-e", "GIT_CONFIG_COUNT=1", "-e", "GIT_CONFIG_KEY_0=core.autocrlf", "-e", "GIT_CONFIG_VALUE_0="]);
  });

  it("adds the labels it is given after its own", async () => {
    const fake = answering(() => ok());
    await (await DockerExecutor.start({ ...OPTS, labels: { "tachikoma.test": "1" } }, fake.run)).stop();
    const run = fake.calls[0]!;
    expect(run.slice(run.indexOf(OPTS.image) - 2, run.indexOf(OPTS.image))).toEqual(["--label", "tachikoma.test=1"]);
  });

  it("starts with the network on as bridge", async () => {
    const fake = answering(() => ok());
    await (await DockerExecutor.start({ ...OPTS, network: "on" }, fake.run)).stop();
    expect(fake.calls[0]!.slice(fake.calls[0]!.indexOf("--network"), fake.calls[0]!.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
  });

  it("says so when the box cannot start", async () => {
    const fake = fakeDocker(() => ({ code: 125, out: "", err: "docker: Error response from daemon: invalid mount config.\n" }));
    await expect(DockerExecutor.start(OPTS, fake.run)).rejects.toThrow(
      "The sandbox could not start: docker: Error response from daemon: invalid mount config.",
    );
  });

  it("runs a command as `docker exec -w <cwd> <box> bash -c <wrapper> _ <command>`, giving its own failure as a result", async () => {
    const fake = answering(() => ({ code: 3, out: "", err: "no\n" }));
    const box = await DockerExecutor.start(OPTS, fake.run);
    expect(await box.exec("exit 3", "/work/src")).toEqual({ code: 3, signal: null, stdout: "", stderr: "no\n" });
    const call = fake.calls.find((c) => c[0] === "exec" && c[1] === "-w")!;
    expect(call.slice(0, 5)).toEqual(["exec", "-w", "/work/src", "b0x", "bash"]);
    expect(call.slice(5)).toEqual(["-c", expect.stringContaining("setsid"), "_", "exit 3"]);
    await box.stop();
  });

  it("when Docker fails during the session, throws its words, and every later call throws the same without running", async () => {
    const words = "Error response from daemon: No such container: b0x";
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (args[0] === "exec" || args[0] === "inspect") return { code: 1, out: "", err: `${words}\n` };
      return ok();
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    const message = `The sandbox stopped working: ${words}. Shell and file tools are off until Tachikoma is launched again.`;
    await expect(box.exec("echo hi", "/work")).rejects.toThrow(message);
    const made = fake.calls.length;
    await expect(box.exec("echo again", "/work")).rejects.toThrow(message);
    expect(fake.calls.length).toBe(made);
  });

  it("adds no second full stop when Docker's words end in one", async () => {
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      return { code: 1, out: "", err: "Error response from daemon: container b0x is not running.\n" };
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    await expect(box.exec("echo hi", "/work")).rejects.toThrow(
      "The sandbox stopped working: Error response from daemon: container b0x is not running. Shell and file tools are off until Tachikoma is launched again.",
    );
  });

  it("says the box stopped when Docker gives no words (choice 92)", async () => {
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (args[0] === "inspect") return ok("false\n");
      return { code: 137, out: "", err: "" };
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    await expect(box.exec("kill -9 -1", "/work")).rejects.toThrow(
      "The sandbox stopped working: the box stopped. Shell and file tools are off until Tachikoma is launched again.",
    );
  });

  it("when Esc cannot reach the box, stops the sandbox instead of saying Cancelled (choice 87)", async () => {
    const words = "OCI runtime exec failed: unable to start container process: resource temporarily unavailable";
    let release: () => void = () => {};
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
      if (args[0] === "exec" && args[1] !== "-w") return { code: 126, out: "", err: `${words}\n` }; // Esc's kill
      return ok();
    });
    const run: DockerRun = (args, opts) =>
      args[1] === "-w"
        ? new Promise((_, reject) => {
            release = () => reject(new Error("The operation was aborted"));
            opts?.signal?.addEventListener("abort", () => setImmediate(release));
          })
        : fake.run(args, opts);
    const box = await DockerExecutor.start(OPTS, run);
    const stop = new AbortController();
    const running = box.exec("sleep 600", "/work", stop.signal);
    await new Promise((resolve) => setImmediate(resolve)); // the command is started
    stop.abort();
    const message = `The sandbox stopped working: Esc could not reach the box (${words}). Shell and file tools are off until Tachikoma is launched again.`;
    await expect(running).rejects.toThrow(message);
    await expect(box.exec("echo hi", "/work")).rejects.toThrow(message);
  });

  it("an Esc while the count is read, before the command starts, runs nothing", async () => {
    const stop = new AbortController();
    let reads = 0;
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) {
        if (++reads === 2) stop.abort(); // the read before the command
        return reads === 1 ? { code: 1, out: "", err: "Error response from daemon: busy\n" } : ok("oom_kill 0\n");
      }
      return ok();
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    await expect(box.exec("echo hi", "/work", stop.signal)).rejects.toThrow("Cancelled");
    expect(fake.calls.some((c) => c[1] === "-w")).toBe(false);
  });

  it("when docker leaves PATH during the session, says so in the same message", async () => {
    let gone = false;
    const fake = fakeDocker((args) => {
      if (gone) return "missing";
      if (args[0] === "run") return ok("b0x\n");
      return ok("oom_kill 0\n");
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    gone = true;
    await expect(box.exec("echo hi", "/work")).rejects.toThrow(
      "The sandbox stopped working: no docker program is on PATH any more. Shell and file tools are off until Tachikoma is launched again.",
    );
  });

  it("has Docker cut each stream as the host's executor does (docker.ts)", async () => {
    const fake = answering(() => ok());
    const box = await DockerExecutor.start(OPTS, fake.run);
    await box.exec("x", "/work");
    expect(fake.options[fake.calls.findIndex((c) => c[0] === "exec" && c[1] === "-w")]).toMatchObject({ cut: true });
    await box.stop();
  });

  // Docker's facts (the coordinator, 2026-11-02): memory.events is cgroup v2's alone, and Ubuntu 20.04 and RHEL 8 use
  // cgroup v1 by default; OOMKilled is there on both.
  it("without memory.events (cgroup v1), says so by Docker's OOMKilled after a 137, and nothing when it is false", async () => {
    for (const [flag, said] of [["true", true], ["false", false]] as const) {
      const fake = fakeDocker((args) => {
        if (args[0] === "run") return ok("b0x\n");
        if (args.includes("/sys/fs/cgroup/memory.events")) return { code: 1, out: "", err: "cat: /sys/fs/cgroup/memory.events: No such file or directory\n" };
        if (args[0] === "exec") return { code: 137, out: "", err: "" };
        if (args.includes("{{.State.OOMKilled}}")) return ok(`${flag}\n`);
        return ok("true\n");
      });
      const box = await DockerExecutor.start({ ...OPTS, limits: { memory: 512 * MB, cpus: 1, pids: 64 } }, fake.run);
      const got = await box.exec("node fill.js", "/work");
      const line = `(Stopped: the command used more than the box's memory limit of 512m. "sandboxLimits" in settings.json changes it.)`;
      expect(got).toEqual({ code: 137, signal: null, stdout: "", stderr: said ? line : "" });
      // A missing file is looked for once, at the start, not before each command.
      expect(fake.calls.filter((c) => c.includes("/sys/fs/cgroup/memory.events"))).toHaveLength(1);
      await box.stop();
    }
  });

  it("when the count could not be read at the start, reads it again before the next command, and uses it, not OOMKilled", async () => {
    let reads = 0;
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) {
        reads++;
        return reads === 1 ? { code: 1, out: "", err: "Error response from daemon: busy\n" } : ok(`oom_kill ${reads === 2 ? 0 : 1}\n`);
      }
      if (args[0] === "exec") return { code: 137, out: "", err: "" };
      return ok("true\n");
    });
    const box = await DockerExecutor.start({ ...OPTS, limits: { memory: 512 * MB, cpus: 1, pids: 64 } }, fake.run);
    const got = await box.exec("node fill.js", "/work");
    expect(got.stderr).toBe(`(Stopped: the command used more than the box's memory limit of 512m. "sandboxLimits" in settings.json changes it.)`);
    expect(reads).toBe(3);
    expect(fake.calls.some((c) => c.includes("{{.State.OOMKilled}}"))).toBe(false);
    await box.stop();
  });

  it("reads the count after any failed command, so a memory kill inside a build that exits 2 is said there (choice 89)", async () => {
    let reads = 0;
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok(`oom_kill ${reads++ === 0 ? 0 : 1}\n`);
      if (args[0] === "exec") return { code: 2, out: "", err: "make: *** [build] Killed\n" };
      return ok("true\n");
    });
    const box = await DockerExecutor.start({ ...OPTS, limits: { memory: 512 * MB, cpus: 1, pids: 64 } }, fake.run);
    expect((await box.exec("make build", "/work")).stderr).toBe(
      `make: *** [build] Killed\n(Stopped: the command used more than the box's memory limit of 512m. "sandboxLimits" in settings.json changes it.)`,
    );
    await box.stop();
  });

  it("without memory.events, does not take OOMKilled for a command that failed with another code than 137", async () => {
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return { code: 1, out: "", err: "cat: /sys/fs/cgroup/memory.events: No such file or directory\n" };
      if (args[0] === "exec") return { code: 2, out: "", err: "" };
      return ok("true\n"); // OOMKilled stays true once it has been (measured): it cannot tell this command's failure
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    expect((await box.exec("make build", "/work")).stderr).toBe("");
    await box.stop();
  });

  // Background commands plan, Task 3 (choice 3): start runs what exec runs, and streams it into a log.
  const MEMORY_LINE = `(Stopped: the command used more than the box's memory limit of 512m. "sandboxLimits" in settings.json changes it.)`;
  // Docker's run of the command (the `-w` exec), held until the test lets it end, or rejecting when the stop's signal
  // aborts, as the real run does; every other call goes to `fake`.
  const holding = (fake: ReturnType<typeof fakeDocker>, pieces: string[], end: Answer) => {
    let release: () => void = () => {};
    const run: DockerRun = (args, opts) => {
      if (args[1] !== "-w") return fake.run(args, opts);
      void fake.run(args, opts); // recorded
      for (const piece of pieces) opts?.data?.(piece);
      return new Promise((resolve, reject) => {
        release = () => resolve(end);
        opts?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    };
    return { run, release: () => release() };
  };

  it("start streams each piece Docker gives into the log in order, before the end, with exec's arguments", async () => {
    const fake = answering(() => ok());
    const docker = holding(fake, ["a", "b", "c"], { code: 0, out: "ac", err: "b" });
    const box = await DockerExecutor.start(OPTS, docker.run);
    const running = box.start("npm run dev", "/work/src");
    let ended = false;
    void running.done.finally(() => (ended = true));
    await new Promise((resolve) => setImmediate(resolve)); // the command is started
    expect(running.log.kept()).toBe("abc");
    expect(ended).toBe(false);
    docker.release();
    expect(await running.done).toEqual({ code: 0, signal: null, stdout: "ac", stderr: "b" });
    const at = fake.calls.findIndex((c) => c[0] === "exec" && c[1] === "-w");
    expect(fake.calls[at]).toEqual(["exec", "-w", "/work/src", "b0x", "bash", "-c", expect.stringContaining("setsid"), "_", "npm run dev"]);
    expect(fake.options[at]).toMatchObject({ cut: true, data: expect.any(Function) });
    await box.stop();
  });

  it("start's stop kills the command's group in the box and settles done as a kill, keeping the log", async () => {
    const fake = answering(() => ok());
    const docker = holding(fake, ["serving\n"], ok());
    const box = await DockerExecutor.start(OPTS, docker.run);
    const running = box.start("npm run dev", "/work");
    await new Promise((resolve) => setImmediate(resolve)); // the command is started
    running.stop();
    expect(await running.done).toEqual({ code: null, signal: "SIGKILL", stdout: "", stderr: "" });
    expect(fake.calls).toContainEqual(["exec", "b0x", "bash", "-c", expect.stringContaining("kill -KILL")]);
    expect(running.log.kept()).toBe("serving\n");
    await box.stop();
  });

  it("start's stop while the count is read, before the command reaches the box, runs nothing", async () => {
    let reads = 0;
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) {
        return ++reads === 1 ? { code: 1, out: "", err: "Error response from daemon: busy\n" } : ok("oom_kill 0\n");
      }
      return ok();
    });
    const box = await DockerExecutor.start(OPTS, fake.run);
    const running = box.start("npm run dev", "/work");
    running.stop();
    expect(await running.done).toEqual({ code: null, signal: "SIGKILL", stdout: "", stderr: "" });
    expect(reads).toBe(2);
    expect(fake.calls.some((c) => c[1] === "-w")).toBe(false);
    await box.stop();
  });

  it("start adds the memory limit's line to stderr and to the log (choice 3)", async () => {
    let reads = 0;
    const fake = fakeDocker((args) => {
      if (args[0] === "run") return ok("b0x\n");
      if (args.includes("/sys/fs/cgroup/memory.events")) return ok(`oom_kill ${reads++ === 0 ? 0 : 1}\n`);
      return ok("true\n");
    });
    const docker = holding(fake, ["make: *** [build] Killed"], { code: 2, out: "", err: "make: *** [build] Killed" });
    const box = await DockerExecutor.start({ ...OPTS, limits: { memory: 512 * MB, cpus: 1, pids: 64 } }, docker.run);
    const running = box.start("make build", "/work");
    await new Promise((resolve) => setImmediate(resolve)); // the command is started
    docker.release();
    expect((await running.done).stderr).toBe(`make: *** [build] Killed\n${MEMORY_LINE}`);
    expect(running.log.kept()).toBe(`make: *** [build] Killed\n${MEMORY_LINE}`);
    await box.stop();
  });

  it("start rejects done with the sandbox's failure when Docker cannot be reached, and throws at once after it", async () => {
    const fake = answering(() => ok());
    const run: DockerRun = (args, opts) => (args[1] === "-w" ? Promise.reject(new Error("spawn docker EACCES")) : fake.run(args, opts));
    const box = await DockerExecutor.start(OPTS, run);
    const message = "The sandbox stopped working: spawn docker EACCES. Shell and file tools are off until Tachikoma is launched again.";
    await expect(box.start("npm run dev", "/work").done).rejects.toThrow(message);
    expect(() => box.start("echo again", "/work")).toThrow(message);
    await box.stop();
  });

  it("exec's Esc while the command runs kills its group in the box and says Cancelled", async () => {
    const fake = answering(() => ok());
    const docker = holding(fake, [], ok());
    const box = await DockerExecutor.start(OPTS, docker.run);
    const esc = new AbortController();
    const running = box.exec("sleep 600", "/work", esc.signal);
    await new Promise((resolve) => setImmediate(resolve)); // the command is started
    esc.abort();
    await expect(running).rejects.toThrow("Cancelled");
    expect(fake.calls).toContainEqual(["exec", "b0x", "bash", "-c", expect.stringContaining("kill -KILL")]);
    await box.stop();
  });

  it("takes Docker's warnings on stderr as no failure when the box starts", async () => {
    const warning = "WARNING: Your kernel does not support swap limit capabilities or the cgroup is not mounted. Memory limited without swap.\n";
    const fake = fakeDocker((args) => (args[0] === "run" ? { code: 0, out: "b0x\n", err: warning } : ok("oom_kill 0\n")));
    const box = await DockerExecutor.start(OPTS, fake.run);
    expect(box.id).toBe("b0x");
    await box.stop();
  });
});

describe("sweepBoxes (the boxes of sessions whose process is gone)", () => {
  it("removes this machine's boxes whose process is gone, and keeps the rest", async () => {
    const gone = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", ""]);
      child.on("close", () => resolve(child.pid!));
    });
    // Only the whole label is this process space (choice 93): the same computer's name for another system, as a WSL
    // distro beside Windows has, or with no system at all, is not.
    const other = `${os.hostname()}/${process.platform === "linux" ? "win32" : "linux"}`;
    const boxes = [`aaa\t${HOST}\t${gone}`, `bbb\t${HOST}\t${process.pid}`, `ccc\tanother-pc\t${gone}`, `ddd\t\t`, `eee\t${other}\t${gone}`];
    boxes.push(`fff\t${os.hostname()}\t${gone}`);
    const fake = fakeDocker((args) => (args[0] === "ps" ? ok(`${boxes.join("\n")}\n`) : ok()));
    await sweepBoxes(fake.run);
    expect(fake.calls).toEqual([
      ["ps", "-a", "--filter", "label=tachikoma.session", "--format", '{{.ID}}\t{{.Label "tachikoma.host"}}\t{{.Label "tachikoma.pid"}}'],
      ["rm", "-f", "aaa"],
    ]);
  });

  it("loads on a Linux whose /proc/self/ns/pid cannot be read (WSL1), labelling boxes without it", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.resetModules();
    vi.doMock("node:fs", async (real) => ({
      ...(await real<typeof import("node:fs")>()),
      readlinkSync: () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, readlink '/proc/self/ns/pid'"), { code: "ENOENT" });
      },
    }));
    onTestFinished(() => {
      Object.defineProperty(process, "platform", platform);
      vi.doUnmock("node:fs");
      vi.resetModules();
    });
    const fresh = await import("../../src/sandbox/executor.js");
    const fake = fakeDocker((args) => ok(args[0] === "run" ? "b0x\n" : "oom_kill 0\n"));
    await (await fresh.DockerExecutor.start(OPTS, fake.run)).stop();
    expect(fake.calls[0]).toContain(`tachikoma.host=${os.hostname()}/linux`);
  });
});

// Real Docker (the plan's "Docker tests run on real Docker and skip themselves"). Each test starts its own box from the
// shipped image, never pulling it (--pull never), with the network off, labelled tachikoma.test=1 and by a `test-`
// session, and removes it when it ends (choice 73). The limits are what Docker here gives (choice 75); the memory test's
// are 512 MB (choice 74). A test of a limit Docker cannot apply here skips, saying so (choice 83).
interface Needs { memory?: number; limit?: Unlimited }
async function ready(ctx: TestContext, needs: Needs = {}): Promise<{ image: string; folder: string; limits: Limits; user: string }> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state !== "ready") ctx.skip(state === "denied" ? "this user is not allowed to use Docker" : "Docker is set to Windows containers");
  const folder = await mkdtemp(path.join(os.tmpdir(), "tachi-box-"));
  onTestFinished(() => rmdir(folder));
  const info = await imageFor(folder);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const space = await dockerRoom();
  if (needs.limit && space.unlimited.includes(needs.limit)) ctx.skip(unlimitedLine(needs.limit));
  if (needs.memory && needs.memory > space.memory) ctx.skip(`Docker has less memory than the test's ${needs.memory} bytes`);
  const got = boxLimits(undefined, space);
  if (!("limits" in got)) ctx.skip(got.problem);
  return { image: info.tag, folder, limits: { ...got.limits, ...(needs.memory ? { memory: needs.memory } : {}) }, user: boxUser(space) };
}

async function realBox(ctx: TestContext, needs?: Needs): Promise<DockerExecutor> {
  return (await realBoxAs(ctx, needs)).box;
}

async function realBoxAs(ctx: TestContext, needs?: Needs): Promise<{ box: DockerExecutor; user: string }> {
  const opts = await ready(ctx, needs);
  const box = await DockerExecutor.start({ ...opts, network: "off", mounts: [], session: `test-${randomUUID()}`, labels: TEST_LABEL });
  onTestFinished(() => box.stop());
  return { box, user: opts.user };
}

const TEST_LABEL = { "tachikoma.test": "1" }; // the plan's rule for every container a test starts

// The box's processes, as `<pid> <command line>` lines, read from /proc: the image has no ps.
const processes = async (box: DockerExecutor) =>
  (await box.exec('for p in /proc/[0-9]*; do echo "${p#/proc/} $(tr "\\0" " " < $p/cmdline)"; done', "/")).stdout;
// The sleep itself, not a wrapper's command line that names it.
const SLEEPING = /^\d+ sleep 600 $/m;

// No time limit, as Docker's own check has none (choice 70): a test here took 3 to 9.5 s (2026-11-02), past Vitest's
// 5 s, and no other number is set without measuring one.
describe("DockerExecutor in real Docker", { timeout: 0 }, () => {
  it("runs as the user Tachikoma chose, with HOME at /tmp (choices 14 and 77)", async (ctx) => {
    const { box, user } = await realBoxAs(ctx);
    expect(await box.exec('id -u; echo "$HOME"', "/work")).toEqual({ code: 0, signal: null, stdout: `${user.split(":")[0]}\n/tmp\n`, stderr: "" });
    const space = await dockerRoom();
    if ((process.platform === "win32" || process.platform === "darwin") && !space.rootless) expect(user).toBe("1000:1000");
  });

  it("gives the command to bash whole, as $1, its quotes and $ untouched", async (ctx) => {
    const box = await realBox(ctx);
    expect((await box.exec(String.raw`printf '%s' "a'b\"c\$HOME"`, "/work")).stdout).toBe(`a'b"c$HOME`);
  });

  it("runs in the cwd it is given", async (ctx) => {
    const box = await realBox(ctx);
    expect((await box.exec("pwd", "/tmp")).stdout).toBe("/tmp\n");
  });

  it("has no capabilities", async (ctx) => {
    const box = await realBox(ctx);
    const caps = (await box.exec("grep ^Cap /proc/self/status", "/work")).stdout;
    expect(caps.trim().split("\n").map((line) => line.split(/\s+/)[1])).toEqual(Array(5).fill("0000000000000000"));
  });

  it("cannot gain privileges", async (ctx) => {
    const box = await realBox(ctx);
    expect((await box.exec("grep ^NoNewPrivs /proc/self/status", "/work")).stdout).toBe("NoNewPrivs:\t1\n");
  });

  it("has no network", async (ctx) => {
    const box = await realBox(ctx);
    expect((await box.exec("getent hosts example.com", "/work")).code).not.toBe(0);
  });

  it("gives a command's own exit code and output, and nothing of its wrapper, even when it is killed", async (ctx) => {
    const box = await realBox(ctx);
    expect(await box.exec("echo out; echo err >&2; exit 3", "/work")).toEqual({ code: 3, signal: null, stdout: "out\n", stderr: "err\n" });
    // A kill that is not the memory limit's says nothing of memory (measured: the box's oom_kill count stays as it was).
    expect(await box.exec("kill -9 $$", "/work")).toEqual({ code: 137, signal: null, stdout: "", stderr: "" });
  });

  it("cuts a stream of more than MAX_TOOL_OUTPUT characters", async (ctx) => {
    const box = await realBox(ctx);
    const got = await box.exec(`head -c ${MAX_TOOL_OUTPUT + 1} /dev/zero | tr '\\0' a`, "/work");
    expect(got.stdout).toBe(`${"a".repeat(MAX_TOOL_OUTPUT)}\n[cut: 1 more characters]`);
  });

  it("stops a command over the memory limit, saying so (a 512 MB box, choice 74)", async (ctx) => {
    const box = await realBox(ctx, { memory: 512 * MB, limit: "memory" });
    const got = await box.exec('node -e "a=[];for(;;)a.push(Buffer.alloc(1e6))"', "/work");
    expect(got.code).toBe(137);
    expect(got.stderr).toBe(`(Stopped: the command used more than the box's memory limit of 512m. "sandboxLimits" in settings.json changes it.)`);
  });

  it("limits the box's CPUs to its limit", async (ctx) => {
    const box = await realBox(ctx, { limit: "CPUs" });
    const got = await box.exec("cat /sys/fs/cgroup/cpu.max", "/work");
    if (got.code !== 0) ctx.skip("the box has no cgroup v2 cpu.max to read its CPU limit from");
    const [quota, period] = got.stdout.trim().split(" ").map(Number);
    expect(quota! / period!).toBeCloseTo(box.limits.cpus, 3);
  });

  it("stops a counted loop of sleep processes one past the process limit (choice 73)", async (ctx) => {
    const box = await realBox(ctx, { limit: "processes" });
    const loop = `python3 -c "import subprocess
for i in range(${box.limits.pids + 1}): subprocess.Popen(['sleep', '600'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"`;
    const got = await box.exec(loop, "/work");
    expect(got.code).not.toBe(0);
    expect(got.stderr).toContain("BlockingIOError: [Errno 11] Resource temporarily unavailable");
  });

  it("Esc stops `sleep 600`, and it is gone from the box (choice 20)", async (ctx) => {
    const box = await realBox(ctx);
    const stop = new AbortController();
    const running = box.exec("sleep 600", "/work", stop.signal);
    let ended = false;
    void running.catch(() => {}).finally(() => (ended = true)); // a command that ends early stops the wait
    while (!ended && !SLEEPING.test(await processes(box))) {
      // looked for again at once: each look is a docker exec of its own
    }
    expect(ended).toBe(false);
    stop.abort();
    await expect(running).rejects.toThrow("Cancelled");
    expect(await processes(box)).not.toMatch(SLEEPING);
  });

  it("Esc at once, before the command has started, leaves nothing running", async (ctx) => {
    const box = await realBox(ctx);
    const stop = new AbortController();
    const running = box.exec("sleep 600", "/work", stop.signal);
    stop.abort();
    await expect(running).rejects.toThrow("Cancelled");
    expect(await processes(box)).not.toMatch(SLEEPING);
  });

  // Background commands plan, Task 3: the real docker run streams each piece into the log as it arrives (choice 3).
  it("start streams output into the log before the end, and its stop leaves nothing running", async (ctx) => {
    const box = await realBox(ctx);
    const running = box.start("echo ready; sleep 600", "/work");
    let ended = false;
    void running.done.catch(() => {}).finally(() => (ended = true)); // a command that ends early stops the wait
    while (!ended && !running.log.kept().includes("ready")) await new Promise((resolve) => setImmediate(resolve)); // lets docker's output in
    expect(ended).toBe(false);
    running.stop();
    expect(await running.done).toEqual({ code: null, signal: "SIGKILL", stdout: "", stderr: "" });
    expect(await processes(box)).not.toMatch(SLEEPING);
  });

  it("stop() removes the box", async (ctx) => {
    const box = await realBox(ctx);
    await box.stop();
    const got = await docker(["inspect", box.id]);
    expect(got !== "missing" && got.code).toBe(1);
  });

  it("removes the box when Tachikoma ends, and when it exits as a signal makes it", async (ctx) => {
    const opts = { ...(await ready(ctx)), network: "off", mounts: [], labels: TEST_LABEL };
    const start = `const { DockerExecutor } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/sandbox/executor.ts")).href)});
const box = await DockerExecutor.start({ ...${JSON.stringify(opts)}, session: "test-" + crypto.randomUUID() });`;
    // Ending by itself, and by process.exit as cli.tsx's signal handlers do (clilib.ts, exitOn), once the id is written.
    for (const end of ["console.log(box.id);", "process.stdout.write(`${box.id}\\n`, () => process.exit(143));"]) {
      const id = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `${start}\n${end}`], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.on("error", reject);
        child.on("close", () => resolve(out.trim()));
      });
      expect(id).toMatch(/^[0-9a-f]{64}$/);
      onTestFinished(async () => void (await docker(["rm", "-f", id]))); // only if the test failed: it is gone otherwise
      const got = await docker(["inspect", id]);
      expect(got !== "missing" && got.code).toBe(1);
    }
  });
});
