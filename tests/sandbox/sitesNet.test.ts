import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { atExit } from "../../src/sandbox/executor.js";
import {
  holdLine,
  leftLine,
  notReady,
  proxyFailed,
  removeSitesNet,
  type SitesOptions,
  startSitesNet,
} from "../../src/sandbox/sitesNet.js";

// 8c-2b plan, Step 5: the launch's own network and its proxy, with a stand-in Docker that records each call and its
// options and answers by the call (release 7 plan, choice 69). No file is run and PATH is not changed.

type Answer = Awaited<ReturnType<DockerRun>>;
type Opts = Parameters<DockerRun>[1];
const ok = (out = ""): Answer => ({ code: 0, out, err: "" });
// A command that never returns: it ends only when its signal is aborted, as the real one is cancelled.
const hang = (o: Opts) =>
  new Promise<Answer>((_, reject) => {
    const stopped = () => reject(new Error("docker was stopped"));
    if (o?.signal?.aborted) stopped();
    o?.signal?.addEventListener("abort", stopped);
  });
const FIRST = '{"port":40103,"udp":53,"tcp":53}';

function fakeDocker(answer: (args: string[], o: Opts) => Answer | Promise<Answer> | undefined = () => undefined) {
  const calls: string[][] = [];
  const options: Opts[] = [];
  const run: DockerRun = async (args, o) => {
    calls.push(args);
    options.push(o);
    const own = await answer(args, o);
    if (own !== undefined) return own;
    if (args[0] === "network" && args[1] === "create") return ok("n3t\n");
    if (args[0] === "run") return ok("pr0xy\n");
    if (args[0] === "logs") {
      o?.line?.(FIRST);
      return hang(o);
    }
    if (args[0] === "inspect") return ok("172.23.0.2\n");
    return ok();
  };
  return { run, calls, options };
}

const GB = 2 ** 30;
const OPTS: SitesOptions = {
  image: "tachikoma-sandbox:0123456789ab",
  session: "s1",
  user: "1000:1000",
  limits: { memory: 4 * GB, cpus: 4, pids: 1024 },
  sites: [{ name: "github.com", port: 443 }],
};
const LIMIT = 50; // a test's own short limit, never the product's (plan, "Rules every builder follows")
const labels = (args: string[]) => args.filter((a, i) => args[i - 1] === "--label");

describe("startSitesNet", () => {
  it("the network is made internal, with the isolated gateway, no IPv6 and the labels", async () => {
    const fake = fakeDocker();
    const got = await startSitesNet(OPTS, fake.run, LIMIT * 100);
    if (!("net" in got)) throw new Error(got.line);
    const name = fake.calls[0]!.at(-1)!;
    expect(name).toMatch(/^tachikoma-sites-[0-9a-f]{12}$/);
    expect(fake.calls[0]).toEqual([
      "network", "create", "--internal", "--ipv6=false", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      "--label", "tachikoma.session=s1", "--label", expect.stringMatching(/^tachikoma\.host=/),
      "--label", `tachikoma.pid=${process.pid}`, name,
    ]);
    expect(got.net.network).toBe(name);
    await removeSitesNet(got.net, fake.run);
  });

  it("Docker refusing the option stops with line 8, nothing else started, nothing left", async () => {
    const words = "Error response from daemon: invalid option: com.docker.network.bridge.gateway_mode_ipv4.\n";
    const fake = fakeDocker((args) => (args[1] === "create" ? { code: 1, out: "", err: words } : undefined));
    expect(await startSitesNet(OPTS, fake.run, LIMIT * 100)).toEqual({
      line: holdLine(
        "Docker could not make the network (Error response from daemon: invalid option: " +
          "com.docker.network.bridge.gateway_mode_ipv4)",
      ),
      left: [],
    });
    expect(fake.calls).toHaveLength(1);
    expect(holdLine("x")).toBe(
      "The sandbox's allowed sites cannot be held on this machine: x. Use --network off or --network on.",
    );
  });

  it("the proxy starts hardened, on the box's image, never pulled, its folder mounted read-only", async () => {
    const fake = fakeDocker();
    const got = await startSitesNet({ ...OPTS, labels: { "tachikoma.test": "1" } }, fake.run, LIMIT * 100);
    if (!("net" in got)) throw new Error(got.line);
    const run = fake.calls.find((c) => c[0] === "run")!;
    expect(run).toEqual([
      "run", "-d", "--pull", "never", "--init", "--name", got.net.proxy, "--user", "1000:1000", "-e", "HOME=/tmp",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", got.net.network,
      "--memory", String(4 * GB), "--memory-swap", String(4 * GB), "--cpus", "4", "--pids-limit", "1024",
      "-v", `${got.net.folder}:/proxy:ro`,
      "--label", "tachikoma.session=s1", "--label", expect.stringMatching(/^tachikoma\.host=/),
      "--label", `tachikoma.pid=${process.pid}`, "--label", "tachikoma.test=1",
      OPTS.image, "node", "/proxy/proxy.cjs",
    ]);
    expect(got.net.proxy).toMatch(/^tachikoma-proxy-[0-9a-f]{12}$/);
    expect(labels(fake.calls[0]!)).toContain("tachikoma.test=1");
    // Then joined to Docker's ordinary network, its output followed, its address read on the launch's network.
    expect(fake.calls.slice(2)).toEqual([
      ["network", "connect", "bridge", got.net.proxy],
      ["logs", "--follow", got.net.proxy],
      ["inspect", "--format", `{{(index .NetworkSettings.Networks "${got.net.network}").IPAddress}}`, got.net.proxy],
    ]);
    expect(got.net).toMatchObject({ address: "172.23.0.2", port: 40103 });
    await removeSitesNet(got.net, fake.run);
  });

  it("leaves out of the proxy's run the flags of each limit Docker cannot apply (choice 83)", async () => {
    const fake = fakeDocker();
    const got = await startSitesNet({ ...OPTS, unlimited: ["CPUs"] }, fake.run, LIMIT * 100);
    if (!("net" in got)) throw new Error(got.line);
    expect(fake.calls.find((c) => c[0] === "run")).not.toContain("--cpus");
    await removeSitesNet(got.net, fake.run);
  });

  it("the proxy's folder holds the list, this computer's addresses and the check's name, gone after", async () => {
    const fake = fakeDocker();
    const got = await startSitesNet(OPTS, fake.run, LIMIT * 100);
    if (!("net" in got)) throw new Error(got.line);
    const settings = JSON.parse(readFileSync(`${got.net.folder}/settings.json`, "utf8")) as Record<string, unknown>;
    const own = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address));
    expect(settings).toEqual({ sites: OPTS.sites, own, check: got.net.check, host: "0.0.0.0", dnsPort: 53 });
    expect(got.net.check).toMatch(/^[0-9a-f]{16}\.invalid$/);
    expect(readFileSync(`${got.net.folder}/proxy.cjs`, "utf8")).toContain("const proxy = ");
    expect(await removeSitesNet(got.net, fake.run)).toEqual([]);
    expect(existsSync(got.net.folder)).toBe(false);
  });

  it("a proxy that exits before its first line gives W9, and the network is removed", async () => {
    const fake = fakeDocker((args, o) => {
      if (args[0] !== "logs") return undefined;
      o?.line?.("node:internal/modules/cjs/loader:1228");
      o?.line?.("Error: Cannot find module '/proxy/proxy.cjs'");
      return ok();
    });
    const got = await startSitesNet(OPTS, fake.run, LIMIT * 100);
    expect(got).toEqual({ line: proxyFailed("Error: Cannot find module '/proxy/proxy.cjs'"), left: [] });
    expect(proxyFailed("x")).toBe("The sandbox's proxy could not start (x).");
    const proxy = fake.calls.find((c) => c[0] === "run")![6]!;
    const network = fake.calls[0]!.at(-1)!;
    expect(fake.calls.slice(-2)).toEqual([["rm", "-f", proxy], ["network", "rm", network]]);
    expect(atExit.proxies.has(proxy) || atExit.networks.has(network)).toBe(false);
  });

  it("a proxy Docker cannot start gives W9 with Docker's words", async () => {
    const err = "docker: Error response from daemon: invalid mount config.\n";
    const fake = fakeDocker((args) => (args[0] === "run" ? { code: 125, out: "", err } : undefined));
    const got = await startSitesNet(OPTS, fake.run, LIMIT * 100);
    expect(got).toEqual({ line: proxyFailed("docker: Error response from daemon: invalid mount config"), left: [] });
  });

  it("every Docker command of the set-up was given the set-up's one signal", async () => {
    const fake = fakeDocker();
    const got = await startSitesNet(OPTS, fake.run, LIMIT * 100);
    if (!("net" in got)) throw new Error(got.line);
    const signal = fake.options[0]!.signal!;
    expect(signal).toBeInstanceOf(AbortSignal);
    fake.calls.forEach((c, i) => {
      // The follow is stopped once its line came, by a signal that also follows the set-up's.
      if (c[0] === "logs") expect(fake.options[i]!.signal!.aborted).toBe(true);
      else expect(fake.options[i]!.signal).toBe(signal);
    });
    await removeSitesNet(got.net, fake.run);
  });

  const hangsAt = (phase: string, at: (args: string[]) => boolean) =>
    it(`a Docker that never returns from ${phase} ends at the limit with W9's second form`, async () => {
      const fake = fakeDocker((args, o) => (at(args) ? hang(o) : undefined));
      const got = await startSitesNet(OPTS, fake.run, LIMIT);
      expect(got).toEqual({ line: notReady(LIMIT), left: [] });
      const i = fake.calls.findIndex(at);
      expect(fake.options[i]!.signal!.aborted).toBe(true);
      const network = fake.calls[0]!.at(-1)!;
      const proxy = fake.calls.find((c) => c[0] === "run")?.[6];
      const removals = fake.calls.filter((c) => c[0] === "rm" || (c[0] === "network" && c[1] === "rm"));
      // The network too when its create was cut, as Docker may have made it all the same (the step's review).
      expect(removals).toEqual([...(proxy ? [["rm", "-f", proxy]] : []), ["network", "rm", network]]);
    });
  hangsAt("network create", (a) => a[1] === "create");
  hangsAt("the proxy's run", (a) => a[0] === "run");
  hangsAt("network connect", (a) => a[1] === "connect");
  hangsAt("the output follow, with a proxy that runs but says nothing", (a) => a[0] === "logs");
  hangsAt("the address read", (a) => a[0] === "inspect");

  it("a folder that cannot be written removes the network and gives the error", async () => {
    const fake = fakeDocker();
    vi.spyOn(os, "tmpdir").mockReturnValue(path.join(os.homedir(), "tachi-no-such-folder", "deeper"));
    onTestFinished(() => void vi.restoreAllMocks());
    await expect(startSitesNet(OPTS, fake.run, LIMIT * 100)).rejects.toThrow(/ENOENT/);
    expect(fake.calls.at(-1)).toEqual(["network", "rm", fake.calls[0]!.at(-1)]);
  });

  it("says the limit in seconds", () => {
    expect(notReady(10_000)).toBe("The sandbox's network and proxy were not ready within 10 s.");
  });
});

// Decision 10a: the cleanup after a failed launch.
describe("removeSitesNet", () => {
  const made = { box: "b0xb0xb0xb0xb0xb0x", proxy: "tachikoma-proxy-aaa", network: "tachikoma-sites-aaa" };

  it("each removal is tried once, the box, the proxy, then the network", async () => {
    const fake = fakeDocker();
    expect(await removeSitesNet(made, fake.run, LIMIT * 100)).toEqual([]);
    expect(fake.calls).toEqual([
      ["rm", "-f", made.box],
      ["rm", "-f", made.proxy],
      ["network", "rm", made.network],
    ]);
    const signal = fake.options[0]!.signal;
    expect(fake.options.every((o) => o?.signal === signal && signal instanceof AbortSignal)).toBe(true);
  });

  it("a removal that fails is named in W15 and the rest are still tried", async () => {
    const fake = fakeDocker((args) => (args[2] === made.proxy ? { code: 1, out: "", err: "boom\n" } : undefined));
    expect(await removeSitesNet(made, fake.run, LIMIT * 100)).toEqual([made.proxy]);
    expect(fake.calls).toHaveLength(3);
    expect(leftLine([made.proxy, made.network])).toBe(
      "Left in Docker: tachikoma-proxy-aaa, tachikoma-sites-aaa. The next launch removes them.",
    );
  });

  it("a removal that never returns is cut at the cleanup's limit, named in W15 with what came after it", async () => {
    const fake = fakeDocker((args, o) => (args[2] === made.proxy ? hang(o) : undefined));
    expect(await removeSitesNet(made, fake.run, LIMIT)).toEqual([made.proxy, made.network]);
    expect(fake.calls).toHaveLength(2);
  });

  it("names a box by its short id", async () => {
    const fake = fakeDocker(() => ({ code: 1, out: "", err: "boom\n" }));
    expect(await removeSitesNet({ box: made.box }, fake.run, LIMIT * 100)).toEqual(["b0xb0xb0xb0x"]);
  });

  it("a network Docker says is not there counts as removed", async () => {
    const missing = `Error response from daemon: network ${made.network} not found\n`;
    const fake = fakeDocker((args) => (args[1] === "rm" ? { code: 1, out: "", err: missing } : undefined));
    expect(await removeSitesNet({ network: made.network }, fake.run, LIMIT * 100)).toEqual([]);
  });

  it("with nothing to remove, makes no call", async () => {
    const fake = fakeDocker();
    expect(await removeSitesNet({}, fake.run, LIMIT)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});
