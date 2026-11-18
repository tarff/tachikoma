// The stand-in Docker for the real command (register.mjs), answering as tests/cli.test.ts's in-process stand-ins do: a
// ready Docker with the image built, the box started as "b0x", its node check and git passing. TACHI_TEST_STANDIN_DOCKER
// is "start-fails" for a box Docker will not start, and "stuck" for one Docker still lists once removed. Nothing is
// recorded unless TACHI_TEST_STANDIN_LOG names a file, which gets each command's arguments as one JSON line; otherwise
// the test reads the command's output and folders.
// A sites launch (8c-2b plan, Step 11) gets its network, its proxy's first line and address, and the launch check's
// passing answers, as tests/sandbox/sitesNet.test.ts's stand-ins give them; "sites-leak" is a box whose check connects
// straight to an outside address.
import { appendFileSync } from "node:fs";
import { dockerState, lineSplitter } from "../../src/sandbox/docker.ts";

export { dockerState, lineSplitter };

const ok = (out = "") => ({ code: 0, out, err: "" });
// This PC's `docker info`, the parts read (tests/sandbox/executor.test.ts).
const INFO = JSON.stringify({ NCPU: 24, MemTotal: 33518923776, SecurityOptions: [], MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true });

// The proxy's first line, and the launch check's answer from a real passing box (tests/sandbox/sitesNet.test.ts).
const FIRST = '{"port":40103,"udp":53,"tcp":53}';
const TRIE = [
  "  +-- 0.0.0.0/0 2 0 2",
  "     +-- 127.0.0.0/8 2 0 2",
  "        +-- 127.0.0.0/31 1 0 0",
  "           |-- 127.0.0.0",
  "              /8 host LOCAL",
  "           |-- 127.0.0.1",
  "              /32 host LOCAL",
  "        |-- 127.255.255.255",
  "           /32 link BROADCAST",
  "     +-- 172.23.0.0/16 2 0 2",
  "        +-- 172.23.0.0/31 1 0 0",
  "           |-- 172.23.0.0",
  "              /16 link UNICAST",
  "           |-- 172.23.0.1",
  "              /32 host LOCAL",
  "        |-- 172.23.255.255",
  "           /32 link BROADCAST",
];
const V6 = [
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
    "ffffffff 00000001 00000000 00200200       lo",
  "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
    "00000000 00000004 00000000 80200001       lo",
];
const RULES = [
  { family: 4, table: 255, attrs: { "14": "ffffffff", "15": "ff000000", "21": "02" } },
  { family: 4, table: 254, attrs: { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" } },
  { family: 4, table: 253, attrs: { "6": "ff7f0000", "14": "ffffffff", "15": "fd000000", "21": "02" } },
  { family: 6, table: 255, attrs: { "14": "ffffffff", "15": "ff000000", "21": "02" } },
  { family: 6, table: 254, attrs: { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" } },
].map((r) => ({ ...r, action: 1, tos: 0, flags: 0, src_len: 0, dst_len: 0 }));
const passing = (check) => ({
  fib_trie: ["Main:", ...TRIE, "Local:", ...TRIE, ""].join("\n"),
  ipv6_route: `${V6.join("\n")}\n`,
  rules: { text: JSON.stringify(RULES) },
  direct: process.env.TACHI_TEST_STANDIN_DOCKER === "sites-leak" ? { connected: true } : { error: "ENETUNREACH" },
  unlisted: { status: `HTTP/1.1 403 Tachikoma's sandbox refused unlisted.${check}:443: not on the allowed sites` },
  tunnel: { status: "HTTP/1.1 200 Connection established", after: 0 },
  lookup: { error: "EAI_AGAIN" },
});
// The launch's network, from its create, and the check's made-up name, from the check's command.
let network = "";
let check = "";

export const docker = async (args, opts = {}) => {
  const log = process.env.TACHI_TEST_STANDIN_LOG;
  if (log) appendFileSync(log, `${JSON.stringify(args)}\n`);
  const [verb] = args;
  if (verb === "network" && args[1] === "create") network = args.at(-1);
  if (verb === "network" && args[1] === "inspect") return ok('[{"Subnet":"172.23.0.0/16"}]\n');
  if (verb === "logs" && args[1] === "--follow") {
    opts.line?.(FIRST);
    return ok();
  }
  if (verb === "logs") return ok(`${FIRST}\n{"lookup":"${check}"}\n`);
  if (verb === "inspect" && args[2]?.includes(".IPAddress")) return ok("172.23.0.2\n"); // the proxy's address
  if (verb === "inspect" && args[2] === "{{json .NetworkSettings.Networks}}") {
    return ok(`{"${network}":{"Gateway":"","IPAddress":"172.23.0.1"}}\n`);
  }
  if (verb === "exec" && args[1] === "-i" && args[3] === "node") {
    check = args[7];
    return ok(JSON.stringify(passing(check)));
  }
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
