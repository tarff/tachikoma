// The stand-in Docker for the real command (register.mjs), answering as tests/cli.test.ts's in-process stand-ins do: a
// ready Docker with the image built, the box started as "b0x", its node check and git passing. TACHI_TEST_STANDIN_DOCKER
// is "start-fails" for a box Docker will not start, and "stuck" for one Docker still lists once removed. Nothing is
// recorded: the test reads the command's output and folders.
import { dockerState, lineSplitter } from "../../src/sandbox/docker.ts";

export { dockerState, lineSplitter };

const ok = (out = "") => ({ code: 0, out, err: "" });
// This PC's `docker info`, the parts read (tests/sandbox/executor.test.ts).
const INFO = JSON.stringify({ NCPU: 24, MemTotal: 33518923776, SecurityOptions: [], MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true });

export const docker = async (args) => {
  const [verb] = args;
  if (verb === "version") return ok("linux\n");
  if (verb === "image") return ok("sha256:0\n");
  if (verb === "info") return ok(`${INFO}\n`);
  if (verb === "run") {
    if (process.env.TACHI_TEST_STANDIN_DOCKER === "start-fails") return { code: 125, out: "", err: "docker: Error response from daemon: made-up failure.\n" };
    return ok("b0x\n");
  }
  if (verb === "exec" && args.includes("/sys/fs/cgroup/memory.events")) return ok("oom_kill 0\n");
  if (verb === "exec" && args[4] === "git") return ok();
  if (verb === "exec" && args[1] === "-w") return ok("v24.22.2 function"); // the node check
  if (verb === "inspect") return ok("true\n");
  if (verb === "ps" && args.includes("-q") && process.env.TACHI_TEST_STANDIN_DOCKER === "stuck") return ok("b0x\n"); // never removed
  return ok();
};
