// Measures what real work needs in the sandbox, so the box's default limits come from numbers, not guesses
// (release 7 design, "Before the build"; plan, Task 1). Not part of Tachikoma: run by hand, once.
//
//   node scripts/measure-sandbox.mjs <results.json> [<linux sfw binary>]
//
// It copies this repo (without node_modules, dist and .git) to a temporary folder, then runs `npm ci`, the test suite
// and `npm run build` there, each in a fresh box from the sandbox image with no limits and the network on. A fresh box per
// step keeps each step's cgroup peaks its own. With an sfw binary, `npm ci` runs as `sfw npm ci` (the user's choice).
// It also tries `--storage-opt size=` to see whether Docker can limit a box's disk here.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [out, sfw] = process.argv.slice(2);
if (!out) {
  console.error("usage: node scripts/measure-sandbox.mjs <results.json> [<linux sfw binary>]");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "..");
// The tag is the first 12 hex of the Dockerfile's SHA-256 (plan, choice 15).
const image = `tachikoma-sandbox:${createHash("sha256").update(readFileSync(join(repo, "sandbox", "Dockerfile"))).digest("hex").slice(0, 12)}`;

function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const results = { when: new Date().toISOString(), image, sfw: Boolean(sfw) };
const info = JSON.parse(docker(["info", "--format", "{{json .}}"]).out);
results.docker = { version: info.ServerVersion, cpus: info.NCPU, memoryBytes: info.MemTotal, driver: info.Driver, kernel: info.KernelVersion };

const work = mkdtempSync(join(tmpdir(), "tachi-measure-"));
cpSync(repo, work, { recursive: true, filter: (src) => !/[\\/](node_modules|dist|\.git)$/.test(src) });
results.copy = work;

// The flags of the plan's choice 18, without the limits being measured for.
function runFlags(name) {
  const flags = ["run", "-d", "--init", "--name", name, "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--network", "bridge", "-v", `${work}:/work`, "-w", "/work", "--label", "tachikoma.measure=1"];
  if (sfw) flags.push("-v", `${resolve(sfw)}:/opt/sfw/sfw:ro`);
  return [...flags, image, "sleep", "infinity"];
}

// `docker stats` reads like "1.5GiB / 31.2GiB"; the first half is the use.
function bytes(text) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)/.exec(text);
  if (!m) return null;
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]];
  return Math.round(Number(m[1]) * unit);
}

function cgroup(box) {
  const read = (file) => docker(["exec", box, "cat", `/sys/fs/cgroup/${file}`]);
  const peak = read("memory.peak");
  const pids = read("pids.peak");
  const cpu = /usage_usec (\d+)/.exec(read("cpu.stat").out);
  return {
    memoryPeakBytes: peak.code === 0 ? Number(peak.out) : `unreadable: ${peak.err}`,
    pidsPeak: pids.code === 0 ? Number(pids.out) : `unreadable: ${pids.err}`,
    cpuSeconds: cpu ? Number(cpu[1]) / 1e6 : null,
  };
}

async function step(name, command) {
  const box = `tachi-measure-${name}-${process.pid}`;
  const started = docker(runFlags(box));
  if (started.code !== 0) throw new Error(`could not start the box for ${name}: ${started.err}`);
  const samples = { memoryBytes: 0, cpuPercent: 0, pids: 0, count: 0 };
  let running = true;
  const sampling = (async () => {
    while (running) {
      const s = await new Promise((done) => {
        const p = spawn("docker", ["stats", "--no-stream", "--format", "{{json .}}", box]);
        let text = "";
        p.stdout.on("data", (d) => (text += d));
        p.on("close", () => done(text));
      });
      try {
        const j = JSON.parse(s);
        samples.memoryBytes = Math.max(samples.memoryBytes, bytes(j.MemUsage) ?? 0);
        samples.cpuPercent = Math.max(samples.cpuPercent, Number.parseFloat(j.CPUPerc) || 0);
        samples.pids = Math.max(samples.pids, Number(j.PIDs) || 0);
        samples.count++;
      } catch {
        // A sample taken as the box stops can be empty.
      }
    }
  })();
  const t0 = performance.now();
  const ran = await new Promise((done) => {
    const p = spawn("docker", ["exec", box, "bash", "-c", command]);
    let tail = "";
    const keep = (d) => (tail = (tail + d).slice(-4000));
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("close", (code) => done({ code, tail }));
  });
  const seconds = (performance.now() - t0) / 1000;
  running = false;
  await sampling;
  const peaks = cgroup(box);
  docker(["rm", "-f", box]);
  const result = {
    command, exitCode: ran.code, seconds: Math.round(seconds), ...peaks,
    averageCpus: peaks.cpuSeconds === null ? null : Math.round((peaks.cpuSeconds / seconds) * 100) / 100,
    dockerStatsPeak: samples, outputTail: ran.tail,
  };
  console.log(`${name}: exit ${ran.code}, ${result.seconds} s, memory.peak ${peaks.memoryPeakBytes}, pids.peak ${peaks.pidsPeak}, ${result.averageCpus} CPUs on average`);
  return result;
}

results.steps = {};
results.steps.npmCi = await step("ci", sfw ? "/opt/sfw/sfw npm ci" : "npm ci");
results.steps.tests = await step("tests", "npm test");
results.steps.build = await step("build", "npm run build");

// Docker's docs say `--storage-opt size=` works only on some storage drivers. 100 MB, then a 200 MB write, shows whether it
// is accepted and whether it holds.
const disk = docker(["run", "--rm", "--storage-opt", "size=100M", "--label", "tachikoma.measure=1", image,
  "bash", "-c", "dd if=/dev/zero of=/tmp/fill bs=1M count=200 2>&1 | tail -1"]);
// Accepted is not enough: the limit holds only if the write past it fails.
const accepted = !/storage-opt|not supported/i.test(disk.err);
results.diskLimit = { accepted, held: accepted && /No space left/i.test(disk.out + disk.err), exitCode: disk.code, out: disk.out, err: disk.err };
console.log(`--storage-opt size=100M: exit ${disk.code}; ${disk.err || disk.out}`);

writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`results in ${out}; the copy stays in ${work}`);
