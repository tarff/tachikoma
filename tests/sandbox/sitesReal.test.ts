import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { describe, expect, it, onTestFinished, type TestContext } from "vitest";
import { commandEnv, onPath } from "../../src/exec/env.js";
import { docker, type DockerRun, dockerState } from "../../src/sandbox/docker.js";
import {
  boxLimits,
  boxUser,
  CHECK_LIMIT_MS,
  DockerExecutor,
  dockerRoom,
  exitCalls,
  type Limits,
  SETUP_LIMIT_MS,
} from "../../src/sandbox/executor.js";
import { imageFor } from "../../src/sandbox/image.js";
import type { Site } from "../../src/sandbox/sites.js";
import { checkSites, routesVerdict, removeSitesNet, startSitesNet } from "../../src/sandbox/sitesNet.js";
import { tempDir } from "../helpers.js";

// 8c-2b plan, Step 7: the allowed sites in real Docker, with the sandbox's own image, never pulled. Every container and
// network a test makes is labelled tachikoma.test=1 and removed when the test ends; the box joins only the network the
// launch made. Names are pointed at addresses with Docker's own --add-host on the proxy (decision 12). Nothing here
// reaches the internet, but the test that runs only with TACHI_TEST_INTERNET=1 (question 1 (a)).

const TEST_LABEL = { "tachikoma.test": "1" };
const LABEL_ARGS = ["--label", "tachikoma.test=1"];
const HARD = ["--pull", "never", "--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", ...LABEL_ARGS];
// Each test's limit: the most the product waits for the set-up (SETUP_LIMIT_MS, 30 s) and for the check
// (CHECK_LIMIT_MS, 10 s), plus the slowest test here whole, 8,888 ms with Docker awake (this file alone, 2026-11-18),
// times 3.4, CI's measured slowdown (vitest.config.ts): 30 + 10 + 30.2 = 70.2 s. A launch's cleanup gets it too, and
// a cut-off launch's longest path fits it: the set-up and its own failed set-up's cleanup, 30 s each, then the box's
// start and stop, 443 and 1,169 ms at their slowest (the design's "Measured while building"), times 3.4: 65.5 s.
const LIMIT_MS = SETUP_LIMIT_MS + CHECK_LIMIT_MS + 8_888 * 3.4;

async function ready(ctx: TestContext): Promise<{ image: string; limits: Limits; user: string }> {
  const state = await dockerState();
  if (state === "missing") ctx.skip("no docker program on PATH");
  if (state === "stopped") ctx.skip("Docker is not running");
  if (state === "denied") ctx.skip("this user is not allowed to use Docker");
  if (state !== "ready") ctx.skip("Docker is set to Windows containers");
  const folder = tempDir("tachi-sites-real-");
  const info = await imageFor(folder);
  if (!info.built) ctx.skip(`the sandbox's image (${info.tag}) is not built`);
  const space = await dockerRoom();
  const got = boxLimits(undefined, space);
  if (!("limits" in got)) ctx.skip(got.problem);
  return { image: info.tag, limits: got.limits, user: boxUser(space) };
}

// A sites launch's network, proxy and box, as the launch makes them (Steps 5 and 6), removed when the test ends. The
// removal is set before the launch starts, so a test cut off by its limit mid-launch still waits for the launch and
// removes, by name, what it made.
async function launch(ctx: TestContext, sites: Site[], addHosts: string[] = []) {
  const o = await ready(ctx);
  const session = `test-${randomUUID()}`;
  const folder = tempDir("tachi-sites-work-");
  const going = (async () => {
    const made = await startSitesNet({ ...o, session, sites, labels: TEST_LABEL, addHosts });
    if (!("net" in made)) throw new Error(made.line);
    try {
      const box = await DockerExecutor.start(
        { ...o, folder, network: made.net, mounts: [], session, labels: TEST_LABEL },
        docker,
      );
      return { net: made.net, box };
    } catch (e) {
      await removeSitesNet(made.net);
      throw e;
    }
  })();
  onTestFinished(async () => {
    const got = await going.catch(() => undefined);
    await got?.box.stop();
  }, LIMIT_MS);
  return { ...o, ...(await going), session };
}

// A container of the box's image, labelled, removed by its name when the test ends, passed, failed or timed out. The
// removal is set before the run; a `docker run` still going then (one that hung) is stopped first, and Docker's answer
// that there is no such container is not a failure. `run` is a stand-in only in the clean-up's own tests at the end.
async function container(args: string[], command: string[], o: { image: string }, run: DockerRun = docker) {
  const name = `tachi-test-${randomUUID().slice(0, 8)}`;
  const stop = new AbortController();
  const going = run(["run", "-d", ...HARD, "--name", name, ...args, o.image, ...command], { signal: stop.signal });
  onTestFinished(async () => {
    stop.abort();
    await going.catch(() => undefined);
    await run(["rm", "-f", name]);
  }, LIMIT_MS);
  const got = await going;
  if (got === "missing" || got.code !== 0) throw new Error(got === "missing" ? "no docker" : got.err);
  return name;
}
const out = async (args: string[], input?: string) => {
  const got = await docker(args, input === undefined ? {} : { input: Buffer.from(input) });
  if (got === "missing") throw new Error("no docker");
  return got;
};
// A node program run in the box with the box's own variables, given on stdin.
const inBox = (box: DockerExecutor, code: string, ...args: string[]) =>
  out(["exec", "-i", box.id, "node", "-", ...args], code);
// TCP tries, each saying how it ended: `connected`, or the error's code, or `no answer` within the try's own 3 s, a
// test's own limit (plan, "Rules every builder follows").
const TRIES = `
const net = require("node:net");
(async () => {
  for (const hp of process.argv.slice(2)) {
    const i = hp.lastIndexOf(":");
    const r = await new Promise((done) => {
      const s = net.connect(Number(hp.slice(i + 1)), hp.slice(0, i));
      s.setTimeout(3000, () => (s.destroy(), done("no answer")));
      s.on("connect", () => (s.destroy(), done("connected")));
      s.on("error", (e) => done(e.code));
    });
    console.log(hp + " " + r);
  }
})();`;

// A lookup in the box, saying `found` or its error's code; a Python urllib request through the proxy variables, saying
// its error; the network's IPv4 block as Docker gives it; question 1's pip command.
const lookupOf = (name: string) =>
  `require("node:dns").lookup(${JSON.stringify(name)}, (e) => console.log(e ? e.code : "found"))`;
const urllib = (url: string) =>
  `import urllib.request\ntry: urllib.request.urlopen('${url}', timeout=5)\nexcept Exception as e: print(e)`;
const subnet = async (network: string) =>
  (await out(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Subnet}}", network])).out.trim();
const PIP = "python3 -m venv /tmp/v && /tmp/v/bin/pip download --no-deps --dest /tmp/d idna";

describe("the allowed sites in real Docker", { timeout: LIMIT_MS }, () => {
  it("the launch check passes", async (ctx) => {
    const { net, box } = await launch(ctx, [{ name: "github.com", port: 443 }]);
    expect(await checkSites(net, box.id)).toBeUndefined();
  });

  it("from the box, a direct connection, a lookup, an unlisted site and the Docker host all fail", async (ctx) => {
    const { box } = await launch(ctx, []);
    const direct = await inBox(box, TRIES, "192.0.2.1:443", "172.17.0.1:80");
    expect(direct.out).toBe("192.0.2.1:443 ENETUNREACH\n172.17.0.1:80 ENETUNREACH\n");
    expect((await inBox(box, lookupOf("example.com"))).out.trim()).not.toBe("found");
    expect((await inBox(box, lookupOf("host.docker.internal"))).out.trim()).not.toBe("found");
    // Python's urllib, as the box's programs use the proxy variables (Step 1): refused by the proxy with line 5.
    const py = await out(["exec", box.id, "python3", "-I", "-c", urllib("https://example.com/")]);
    expect(py.out).toContain("403 Tachikoma's sandbox refused example.com:443: not on the allowed sites");
  });

  it("a listener on Docker's host side is not reached through the would-be gateway, but from bridge", async (ctx) => {
    const o = await ready(ctx);
    const listen =
      'const s=require("node:net").createServer((c)=>c.end("hello\\n"));' +
      's.listen(0,"0.0.0.0",()=>console.log(s.address().port))';
    const host = await container(["--network", "host", "--user", o.user], ["node", "-e", listen], o);
    let port = "";
    for (let i = 0; i < 50 && !port; i++) {
      port = (await out(["logs", host])).out.trim();
      if (!port) await new Promise((r) => setTimeout(r, 100));
    }
    const { box, net } = await launch(ctx, []);
    const base = (await subnet(net.network)).split("/")[0]!.split(".").slice(0, 3).join(".");
    const tries = ["172.17.0.1", `${base}.1`, `${base}.254`].map((a) => `${a}:${port}`);
    const got = (await inBox(box, TRIES, ...tries)).out;
    expect(got).not.toContain("connected");
    const control = await out(
      ["run", "--rm", "-i", ...HARD, "--network", "bridge", "--user", o.user, o.image, "node", "-",
        `172.17.0.1:${port}`],
      TRIES,
    );
    expect(control.out).toBe(`172.17.0.1:${port} connected\n`);
  });

  // The user's choice after Step 7: NO_PROXY keeps the box's own loopback direct.
  it("a server on the box's own 127.0.0.1 is reached directly, and an outside name still goes to the proxy", async (ctx) => {
    const { box } = await launch(ctx, []);
    const code = `
      const http = require("node:http"), cp = require("node:child_process");
      const s = http.createServer((q, r) => r.end("inside")).listen(0, "127.0.0.1", async () => {
        const url = "http://127.0.0.1:" + s.address().port + "/";
        const out = [await (await fetch(url)).text()];
        const python = (py) => new Promise((done) => {
          const c = cp.spawn("python3", ["-I", "-c", py]);
          let o = "";
          c.stdout.on("data", (d) => (o += d));
          c.on("close", () => done(o.trim()));
        });
        out.push(await python("import urllib.request; print(urllib.request.urlopen('" + url + "').read().decode())"));
        // Plain http to an outside name: the proxy answers it, with line 5 (Step 1: urllib asks it in full).
        out.push(await python("import urllib.request\\ntry: urllib.request.urlopen('http://example.com/')\\n" +
          "except Exception as e: print(e)"));
        console.log(JSON.stringify(out));
        s.close();
      });`;
    const got = await inBox(box, code);
    const refused = "HTTP Error 403: Tachikoma's sandbox refused example.com:80: not on the allowed sites";
    expect([got.err, JSON.parse(got.out || "null")]).toEqual(["", ["inside", "inside", refused]]);
  });

  it("a lookup from the box reaches only the proxy", async (ctx) => {
    const o = await ready(ctx);
    // A logging lookup server elsewhere, on Docker's ordinary network, which no lookup should reach.
    const log =
      'const u=require("node:dgram").createSocket("udp4");' +
      'u.on("message",(m)=>console.log("got "+m.length));u.bind(53,()=>console.log("up"))';
    const elsewhere = await container(["--network", "bridge", "--user", o.user], ["node", "-e", log], o);
    const { box, net } = await launch(ctx, []);
    await inBox(box, 'require("node:dns").lookup(process.argv[2], () => {})', net.check);
    await new Promise((r) => setTimeout(r, 500));
    expect((await out(["logs", elsewhere])).out).not.toContain("got");
    expect((await out(["logs", net.proxy])).out).toContain(`{"lookup":"${net.check}"}`);
  });

  it("an allowed name pointing at one of this computer's own addresses is refused", async (ctx) => {
    const own = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
    if (!own) ctx.skip("this computer has no outside IPv4 address");
    const { box } = await launch(ctx, [{ name: "mine.example", port: 443 }], [`mine.example:${own!.address}`]);
    const py = await out(["exec", box.id, "python3", "-I", "-c", urllib("https://mine.example/")]);
    expect(py.out).toContain("403 Tachikoma's sandbox refused mine.example:443: it points at a local address");
  });

  it("the check stops a box on Docker's ordinary network", async (ctx) => {
    const o = await ready(ctx);
    const name = await container(["--network", "bridge", "--user", o.user], ["sleep", "infinity"], o);
    const files = await out(["exec", name, "cat", "/proc/net/fib_trie"]);
    const v6 = await out(["exec", name, "cat", "/proc/net/ipv6_route"]);
    const verdict = routesVerdict({ fib_trie: files.out, ipv6_route: v6.out }, await subnet("bridge"));
    expect(verdict).toBe("the box has a route out");
  });

  it("after the stop, Docker lists no proxy and no network of the launch", async (ctx) => {
    const { box, net } = await launch(ctx, []);
    await box.stop();
    expect((await out(["ps", "-a", "-q", "--filter", `name=${net.proxy}`])).out.trim()).toBe("");
    expect((await out(["network", "ls", "-q", "--filter", `name=${net.network}`])).out.trim()).toBe("");
  });

  it("the exit path's two calls remove them too", async (ctx) => {
    const { box, net } = await launch(ctx, []);
    const exe = onPath("docker")!;
    for (const args of exitCalls([box.id], [net.proxy], [net.network])) {
      spawnSync(exe, args, { env: commandEnv(), windowsHide: true, stdio: "ignore" });
    }
    expect((await out(["ps", "-a", "-q", "--filter", `id=${box.id}`])).out.trim()).toBe("");
    expect((await out(["ps", "-a", "-q", "--filter", `name=${net.proxy}`])).out.trim()).toBe("");
    expect((await out(["network", "ls", "-q", "--filter", `name=${net.network}`])).out.trim()).toBe("");
  });
});

// Question 1 (a): only with TACHI_TEST_INTERNET=1, the three sites and exact commands the user approved.
describe.runIf(process.env.TACHI_TEST_INTERNET === "1")("the allowed sites on the internet", () => {
  const PYPI: Site[] = [{ name: "pypi.org", port: 443 }, { name: "files.pythonhosted.org", port: 443 }];
  it("a listed site works for git, pip and a curl-style request", async (ctx) => {
    const { box, net } = await launch(ctx, [{ name: "github.com", port: 443 }, ...PYPI]);
    expect(await checkSites(net, box.id)).toBeUndefined();
    const git = await box.exec("git ls-remote https://github.com/git/git HEAD", "/tmp");
    expect([git.code, git.stdout]).toEqual([0, expect.stringMatching(/^[0-9a-f]{40}\tHEAD\n$/)]);
    const pip = await box.exec(PIP, "/tmp");
    expect(pip.code).toBe(0);
    const url = await box.exec(
      "python3 -I -c \"import urllib.request; print(urllib.request.urlopen('https://pypi.org/simple/idna/').status)\"",
      "/tmp",
    );
    expect(url.stdout.trim()).toBe("200");
  }, 180_000);

  it("pip fails with its files' site left off the list", async (ctx) => {
    const { box } = await launch(ctx, [PYPI[0]!]);
    const pip = await box.exec(PIP, "/tmp");
    expect(pip.code).not.toBe(0);
  }, 180_000);
});

// Cleanup plan, step 20: container()'s clean-up with a stand-in docker that records its calls, so no Docker is needed.
// In each pair, the first test makes a container and ends; the second sees what the clean-up did when the first ended.
describe("a container's clean-up, with a stand-in docker", () => {
  const calls: string[][] = [];
  const standIn =
    (hangs: boolean): DockerRun =>
    (args, opts = {}) => {
      calls.push(args);
      if (args[0] !== "run" || !hangs) return Promise.resolve({ code: 0, out: "", err: "" });
      return new Promise((_, reject) =>
        opts.signal?.addEventListener("abort", () => {
          calls.push(["stopped"]);
          reject(new Error("docker was stopped"));
        }),
      );
    };
  const nameIn = (args: string[]) => args[args.indexOf("--name") + 1];

  it("a run that never returns is still going when its test ends", () => {
    calls.length = 0;
    void container([], ["sleep", "infinity"], { image: "stand-in" }, standIn(true)).catch(() => undefined);
    expect(calls.map((c) => c[0])).toEqual(["run"]);
  });

  it("that run was stopped, then its container removed by name", () => {
    expect(calls).toEqual([expect.arrayContaining(["run"]), ["stopped"], ["rm", "-f", nameIn(calls[0]!)]]);
  });

  it("a run that returns normally ends its test", async () => {
    calls.length = 0;
    const name = await container([], ["sleep", "infinity"], { image: "stand-in" }, standIn(false));
    expect(nameIn(calls[0]!)).toBe(name);
  });

  it("that container was removed by name", () => {
    expect(calls).toEqual([expect.arrayContaining(["run"]), ["rm", "-f", nameIn(calls[0]!)]]);
  });
});

