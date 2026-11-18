import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DockerRun } from "../../src/sandbox/docker.js";
import { atExit, type SitesNet } from "../../src/sandbox/executor.js";
import {
  BOX_CHECK,
  checkSites,
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

// 8c-2b plan, Step 6 (choice 8, decision 9a, question 3 and the user's answers after Step 1): the launch check, judged
// by Tachikoma from the raw answers of Docker and of one script in the box. The route texts are those Step 1 recorded
// from a real passing box (the design's "Measured while building" section).
const NET: SitesNet = {
  network: "tachikoma-sites-aaa", proxy: "tachikoma-proxy-aaa", address: "172.23.0.2", port: 40103,
  folder: "unused", check: "c0ffee.invalid",
};
const TRIE_BODY = [
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
const trie = (main: string[] = TRIE_BODY, before: string[] = []) =>
  [...before, "Main:", ...main, "Local:", ...TRIE_BODY, ""].join("\n");
const V6 = [
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
    "ffffffff 00000001 00000000 00200200       lo",
  "00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
    "00000000 00000004 00000000 80200001       lo",
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
    "ffffffff 00000001 00000000 00200200       lo",
];
const RULES = [
  { family: 4, table: 255, attrs: { "14": "ffffffff", "15": "ff000000", "21": "02" } },
  { family: 4, table: 254, attrs: { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" } },
  { family: 4, table: 253, attrs: { "6": "ff7f0000", "14": "ffffffff", "15": "fd000000", "21": "02" } },
  { family: 6, table: 255, attrs: { "14": "ffffffff", "15": "ff000000", "21": "02" } },
  { family: 6, table: 254, attrs: { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" } },
].map((r) => ({ ...r, action: 1, tos: 0, flags: 0, src_len: 0, dst_len: 0 }));
const PASS = {
  fib_trie: trie(),
  ipv6_route: `${V6.join("\n")}\n`,
  rules: { text: JSON.stringify(RULES) },
  direct: { error: "ENETUNREACH" },
  unlisted: {
    status: "HTTP/1.1 403 Tachikoma's sandbox refused unlisted.c0ffee.invalid:443: not on the allowed sites",
  },
  tunnel: { status: "HTTP/1.1 200 Connection established", after: 0 },
  lookup: { error: "EAI_AGAIN" },
};
type Check = typeof PASS | Record<string, unknown>;

function checking(
  answer: Partial<Record<keyof typeof PASS, unknown>> = {},
  docker: (args: string[]) => Answer | undefined = () => undefined,
) {
  return fakeDocker((args, o) => {
    const own = docker(args);
    if (own !== undefined) return own;
    if (args[0] === "network" && args[1] === "inspect") return ok('[{"Subnet":"172.23.0.0/16"}]\n');
    if (args[0] === "inspect") return ok(`{"${NET.network}":{"Gateway":"","IPAddress":"172.23.0.1"}}\n`);
    if (args[0] === "exec") return ok(JSON.stringify({ ...PASS, ...answer } as Check));
    if (args[0] === "logs") return ok(`${FIRST}\n{"lookup":"${NET.check}"}\n`);
    return hang(o);
  });
}

describe("checkSites", () => {
  it("passes when every item of question 3 holds and the lookup shows at the proxy", async () => {
    const fake = checking();
    expect(await checkSites(NET, "b0x", fake.run, LIMIT * 100)).toBeUndefined();
    expect(fake.calls).toEqual([
      ["network", "inspect", "--format", "{{json .IPAM.Config}}", NET.network],
      ["inspect", "--format", "{{json .NetworkSettings.Networks}}", "b0x"],
      ["exec", "-i", "b0x", "node", "-", NET.address, String(NET.port), NET.check],
      ["logs", NET.proxy],
    ]);
    expect(fake.options[2]!.input!.toString()).toBe(BOX_CHECK);
    const signal = fake.options[0]!.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(fake.options.every((o) => o?.signal === signal)).toBe(true);
  });

  type Docker = Parameters<typeof checking>[1];
  const stops = async (ending: string | undefined, answer: Parameters<typeof checking>[0], docker?: Docker) =>
    expect(await checkSites(NET, "b0x", checking(answer, docker).run, LIMIT * 100)).toBe(ending);

  it("a network with a gateway", () =>
    stops("the box's network has a gateway", {}, (a) =>
      a[1] === "inspect" ? ok('[{"Subnet":"172.23.0.0/16","Gateway":"172.23.0.1"}]') : undefined));
  it("a box joined to a second network", () =>
    stops("the box is joined to another network", {}, (a) =>
      a[0] === "inspect" ? ok(`{"${NET.network}":{"IPAddress":"172.23.0.1"},"bridge":{}}`) : undefined));
  it("a default route in the main table", () =>
    stops("the box has a route out", {
      fib_trie: trie([TRIE_BODY[0]!, "     |-- 0.0.0.0", "        /0 universe UNICAST", ...TRIE_BODY.slice(1)]),
    }));
  it("a route beyond the network's block in the main table", () =>
    stops("the box has a route out", {
      fib_trie: trie([...TRIE_BODY, "     |-- 10.99.0.0", "        /16 universe UNICAST"]),
    }));
  it("an IPv6 route beyond loopback, link-local and multicast", () =>
    stops("the box has a route out", {
      ipv6_route: [...V6, "20000000000000000000000000000000 03 00000000000000000000000000000000 00 " +
        "fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth0"].join("\n"),
    }));
  it("an everything route that is not the kernel's own refusal", () =>
    stops("the box has a route out", {
      ipv6_route: [V6[1], "00000000000000000000000000000000 00 00000000000000000000000000000000 00 " +
        "00000000000000000000000000000000 00000400 00000001 00000000 00000001     eth0"].join("\n"),
    }));
  it("link-local and multicast routes are allowed", () =>
    stops(undefined, {
      ipv6_route: [...V6,
        "fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
          "00000100 00000001 00000000 00000001     eth0",
        "ff000000000000000000000000000000 08 00000000000000000000000000000000 00 00000000000000000000000000000000 " +
          "00000100 00000001 00000000 00000001     eth0",
      ].join("\n"),
    }));
  it("a direct connection that connects", () =>
    stops("the box connected straight to an outside address", { direct: { connected: true } }));
  it("one that fails any other way than the system's refusal", () =>
    stops("the box has a route out", { direct: { error: "ETIMEDOUT" } }));
  it("an unlisted site let through", () =>
    stops("the proxy let through a site that is not listed", {
      unlisted: { status: "HTTP/1.1 200 Connection established" },
    }));
  // The review after Step 12: only a 2xx answer let the site through; no answer, or another one, is said as such.
  it("an unlisted site with no answer, no status or a status other than 403 and 2xx", async () => {
    const odd = "the proxy did not answer as it should for a site that is not listed";
    await stops(odd, { unlisted: undefined });
    await stops(odd, { unlisted: {} });
    await stops(odd, { unlisted: { status: "HTTP/1.1 502 Bad Gateway" } });
  });
  it("a tunnel without a greeting that got bytes back", () =>
    stops("the proxy let through a tunnel that did not open with a TLS greeting", {
      tunnel: { status: "HTTP/1.1 200 Connection established", after: 21 },
    }));
  it("a lookup the proxy did not see", () =>
    stops("the box's lookup did not reach the proxy", {}, (a) => (a[0] === "logs" ? ok(`${FIRST}\n`) : undefined)));
  it("a check that cannot run", () =>
    stops("the check could not run (OCI runtime exec failed: exec failed)", {}, (a) =>
      a[0] === "exec" ? { code: 126, out: "", err: "OCI runtime exec failed: exec failed.\n" } : undefined));
  it("a check whose answer is not JSON cannot run", () =>
    stops("the check could not run (its answer could not be read)", {}, (a) =>
      a[0] === "exec" ? ok("Killed\n") : undefined));

  // The second review's finding 1: a route out in another table, with the main table clean.
  it("a clean main table, a route out in another table, and the direct connection unreachable stop it", () =>
    stops("the box has a route out", {
      fib_trie: trie(TRIE_BODY, ["Id 100:", "  |-- 0.0.0.0", "     /0 universe UNICAST"]),
    }));
  it("a third table with no route in it stops it too", () =>
    stops("the box has a route out", { fib_trie: trie(TRIE_BODY, ["Id 100:"]) }));

  it("a route list that cannot be read, is empty, or is not in the form Step 1 recorded stops the launch", async () => {
    const unread = "the box's routes could not be read";
    await stops(unread, { fib_trie: { error: "EACCES" } });
    await stops(unread, { fib_trie: "" });
    await stops(unread, { fib_trie: trie([...TRIE_BODY, "     ?? something else"]) });
    await stops(unread, { fib_trie: ["Local:", ...TRIE_BODY].join("\n") });
    await stops(unread, { ipv6_route: { error: "ENOENT" } }); // the user's answer: a missing file stops the launch
    await stops(unread, { ipv6_route: "not a route\n" });
    await stops(unread, { ipv6_route: "" }); // every box lists loopback at least (the step's review)
  });

  // The user's answer after Step 1: the rules are read with python3 where the image has it.
  it("a rule beyond the kernel's standard ones stops the launch", () =>
    stops("the box has a route out", {
      rules: {
        text: JSON.stringify([...RULES, { ...RULES[1]!, table: 100, attrs: { "6": "e8030000", "15": "64000000" } }]),
      },
    }));
  it("a standard rule changed in any field stops it too", () =>
    stops("the box has a route out", {
      rules: { text: JSON.stringify([{ ...RULES[0]!, src_len: 8 }, ...RULES.slice(1)]) },
    }));
  it("a rules answer that cannot be read stops the launch", async () => {
    await stops("the box's routes could not be read", { rules: { text: "Traceback (most recent call last)" } });
    await stops("the box's routes could not be read", { rules: { error: "netlink error -13" } });
  });
  it("an image with no python3 relies on the route tables", () => stops(undefined, { rules: { missing: true } }));

  const hangsIn = (phase: string, at: (args: string[]) => boolean) =>
    it(`a Docker that never returns from ${phase} ends at the check limit`, async () => {
      const fake = checking();
      const run: DockerRun = (args, o) => (at(args) ? (fake.run(args, o), hang(o)) : fake.run(args, o));
      expect(await checkSites(NET, "b0x", run, LIMIT)).toBe(`the check did not finish within ${LIMIT / 1000} s`);
      expect(fake.options[fake.calls.findIndex(at)]!.signal!.aborted).toBe(true);
    });
  hangsIn("the network's description", (a) => a[0] === "network");
  hangsIn("the box's description", (a) => a[0] === "inspect");
  hangsIn("the script in the box, or a proxy that never answers it", (a) => a[0] === "exec");
  hangsIn("the read of the proxy's output", (a) => a[0] === "logs");

  it("the box's script stands alone", () => {
    expect(BOX_CHECK).toContain("python3");
    expect(BOX_CHECK).not.toMatch(/require\(["'](?!node:)/);
  });
});
