// A sites launch's own network and its proxy (8c-2b design, section 2; plan, Step 5 and decisions 1, 6, 10 and 10a):
// made before the box, each Docker command under the set-up's one limit, and removed after a failure under a limit of
// its own. Docker is reached only through a DockerRun (release 7 plan, choice 69).
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { errorText } from "../core/types.js";
import { docker, type DockerRun } from "./docker.js";
import {
  atExit,
  BOX_HOME,
  CHECK_LIMIT_MS,
  type Limits,
  NO_DOCKER,
  removeProxyFolder,
  SETUP_LIMIT_MS,
  type SitesNet,
  tachiLabels,
  type Unlimited,
} from "./executor.js";
import { proxyFile, type ProxySettings } from "./proxy.js";
import type { Site } from "./sites.js";

// What the set-up needs: the box's image, session, user and limits (the proxy gets the box's own, question 10), the
// entries in force, and labels added to Tachikoma's own, as a test's are (BoxOptions.labels).
export interface SitesOptions {
  image: string;
  session: string;
  user: string;
  limits: Limits;
  unlimited?: Unlimited[];
  sites: Site[];
  labels?: Record<string, string>;
}

// The design's line 8, W9's two forms and W15.
export const holdLine = (ending: string) =>
  `The sandbox's allowed sites cannot be held on this machine: ${ending}. Use --network off or --network on.`;
export const proxyFailed = (words: string) => `The sandbox's proxy could not start (${words}).`;
export const notReady = (ms: number) => `The sandbox's network and proxy were not ready within ${ms / 1000} s.`;
export const leftLine = (left: string[]) => `Left in Docker: ${left.join(", ")}. The next launch removes them.`;

// What a launch has made, for the cleanup.
export interface Made {
  box?: string;
  proxy?: string;
  network?: string;
  folder?: string;
}

type Answer = Awaited<ReturnType<DockerRun>>;
// Docker's words, without a last full stop, as they go inside the line's brackets.
const words = (got: Answer) =>
  (got === "missing" ? NO_DOCKER : got.err.trim() || got.out.trim() || `exit code ${got.code}`).replace(/\.$/, "");
class Late extends Error {}

// The network, the proxy's folder, the proxy, its join to Docker's ordinary network, its first line and its address,
// in that order (decision 10), or the launch's line and what could not be removed (W15).
export async function startSitesNet(
  o: SitesOptions,
  run: DockerRun = docker,
  limitMs = SETUP_LIMIT_MS,
): Promise<{ net: SitesNet } | { line: string; left: string[] }> {
  // Decision 6: one signal, made just before the set-up's first Docker command, given to each of its commands.
  const signal = AbortSignal.timeout(limitMs);
  const made: Made = {};
  const id = randomBytes(6).toString("hex");
  const network = `tachikoma-sites-${id}`;
  const proxy = `tachikoma-proxy-${id}`;
  const extra = Object.entries(o.labels ?? {}).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const labels = [...tachiLabels(o.session), ...extra];
  const call = async (args: string[], opts: Parameters<DockerRun>[1] = {}): Promise<Answer> => {
    let got: Answer;
    try {
      got = await run(args, { signal, ...opts });
    } catch (e) {
      if (signal.aborted) throw new Late();
      return { code: 1, out: "", err: errorText(e) };
    }
    if (signal.aborted) throw new Late();
    return got;
  };
  const failed = (got: Answer) => got === "missing" || got.code !== 0;
  const fail = async (line: string) => ({ line, left: await removeSitesNet(made, run, limitMs) });
  try {
    // Held from before its create, as a create cut by the limit may still have made it (the step's review); a removal
    // of one Docker never made counts as done (removeSitesNet).
    made.network = network;
    atExit.networks.add(network);
    const created = await call([
      "network", "create", "--internal", "--ipv6=false", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      ...labels, network,
    ]);
    // A Docker that refuses the option stops the launch, never a weaker network (design, section 2).
    if (failed(created)) {
      delete made.network;
      atExit.networks.delete(network);
      return await fail(holdLine(`Docker could not make the network (${words(created)})`));
    }
    const check = `${randomBytes(8).toString("hex")}.invalid`; // never resolves (RFC 6761; decision 9)
    made.folder = proxyFolder(o.sites, check);
    // Named before it runs: `docker rm -f` of a name that is not there exits 0 (measured 2026-11-18, Docker 29.9.3).
    made.proxy = proxy;
    atExit.proxies.add(proxy);
    const { memory, cpus, pids } = o.limits;
    const unlimited = o.unlimited ?? [];
    const limit = (what: Unlimited, flags: string[]) => (unlimited.includes(what) ? [] : flags);
    const ran = await call([
      "run", "-d", "--pull", "never", "--init", "--name", proxy, "--user", o.user, "-e", `HOME=${BOX_HOME}`,
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", network,
      ...limit("memory", ["--memory", String(memory), "--memory-swap", String(memory)]),
      ...limit("CPUs", ["--cpus", String(cpus)]), ...limit("processes", ["--pids-limit", String(pids)]),
      "-v", `${made.folder}:/proxy:ro`, ...labels, o.image, "node", "/proxy/proxy.cjs",
    ]);
    if (failed(ran)) return await fail(proxyFailed(words(ran)));
    const joined = await call(["network", "connect", "bridge", proxy]);
    if (failed(joined)) return await fail(proxyFailed(words(joined)));
    // Its output followed until its first line, which names its port, or until it ends; the follow is then stopped.
    const stop = new AbortController();
    let port: number | undefined;
    let last = "";
    const followed = await call(["logs", "--follow", proxy], {
      signal: AbortSignal.any([signal, stop.signal]),
      line: (text) => {
        if (port !== undefined) return;
        try {
          const first = JSON.parse(text) as { port?: unknown };
          if (Number.isInteger(first.port)) {
            port = first.port as number;
            return stop.abort();
          }
        } catch {
          // not the first line
        }
        if (text.trim()) last = text.trim();
      },
    });
    if (port === undefined) return await fail(proxyFailed(last.replace(/\.$/, "") || words(followed)));
    const format = `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`;
    const inspected = await call(["inspect", "--format", format, proxy]);
    const address = failed(inspected) ? "" : (inspected as { out: string }).out.trim();
    // A proxy that has ended has no address: Docker prints `invalid IP` (measured at Step 1).
    if (!net.isIPv4(address)) return await fail(proxyFailed(address || words(inspected)));
    return { net: { network, proxy, address, port, folder: made.folder, check } };
  } catch (e) {
    if (e instanceof Late) return await fail(notReady(limitMs));
    // Any other failure, such as a temp folder that cannot be written, removes what was made first (the step's review).
    await removeSitesNet(made, run, limitMs);
    throw e;
  }
}

// The launch check's script in the box (8c-2b plan, Step 6 and decision 9a). It stands alone, as helper.ts does, and
// only reads and reports, as raw text, for Tachikoma to judge: the route files; the routing rules through python3's
// netlink socket where the image has python3 (the user's answer after Step 1); a direct connection to 192.0.2.1:443, an
// address set aside for documentation (RFC 5737); a tunnel to an unlisted name; a tunnel to the check's name that
// opens with an SSH greeting; and a lookup of the check's name.
export function boxCheck(require: NodeJS.Require, args: string[], rulesPy: string): void {
  const fs: typeof import("node:fs") = require("node:fs");
  const net: typeof import("node:net") = require("node:net");
  const dns: typeof import("node:dns") = require("node:dns");
  const cp: typeof import("node:child_process") = require("node:child_process");
  const [proxy, port, check] = args as [string, string, string];
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (e) {
      return { error: String((e as NodeJS.ErrnoException).code) };
    }
  };
  const rules = () => {
    const r = cp.spawnSync("python3", ["-I", "-c", rulesPy], { encoding: "utf8" });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (r.error) return code === "ENOENT" ? { missing: true } : { error: String(code) };
    if (r.status === 0) return { text: r.stdout };
    return { error: r.stderr.trim().split("\n").pop() || `exit code ${r.status}` };
  };
  const direct = () =>
    new Promise((done) => {
      const s = net.connect(443, "192.0.2.1");
      s.on("connect", () => (s.destroy(), done({ connected: true })));
      s.on("error", (e: NodeJS.ErrnoException) => done({ error: String(e.code) }));
    });
  // A tunnel's answer line, and how many bytes came back after it (after `then` was sent, when it is given).
  const tunnel = (target: string, then?: string) =>
    new Promise((done) => {
      const s = net.connect(Number(port), proxy);
      let head = "";
      let status: string | undefined;
      let after = 0;
      const end = () => (s.destroy(), done({ status: status ?? head.split("\r\n")[0], after }));
      s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      s.on("data", (d: Buffer) => {
        if (status !== undefined) return ((after += d.length), end());
        head += d.toString("latin1");
        const at = head.indexOf("\r\n\r\n");
        if (at < 0) return;
        status = head.slice(0, head.indexOf("\r\n"));
        after = head.length - at - 4;
        if (then && after === 0 && status.startsWith("HTTP/1.1 200")) s.write(then);
        else end();
      });
      s.on("close", end);
      s.on("error", () => {});
    });
  const lookup = () =>
    new Promise((done) =>
      dns.lookup(check, (e) => done(e ? { error: String((e as NodeJS.ErrnoException).code) } : { resolved: true })),
    );
  void (async () => {
    const out = {
      fib_trie: read("/proc/net/fib_trie"),
      ipv6_route: read("/proc/net/ipv6_route"),
      rules: rules(),
      direct: await direct(),
      unlisted: await tunnel(`unlisted.${check}:443`),
      tunnel: await tunnel(`${check}:443`, "SSH-2.0-Tachikoma_check\r\n"),
      lookup: await lookup(),
    };
    process.stdout.write(JSON.stringify(out));
  })();
}

// The routing rules, through the kernel's netlink socket (RTM_GETRULE), for IPv4 and IPv6, as one JSON list. Measured
// on 2026-11-18 in the box's image as the box's user with no capability (the design's "Measured while building").
const RULES_PY = [
  "import json, socket, struct",
  "out = []",
  "for fam, name in ((socket.AF_INET, 4), (socket.AF_INET6, 6)):",
  "    s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)",
  "    s.bind((0, 0))",
  '    s.send(struct.pack("IHHII", 28, 34, 0x301, 1, 0) + struct.pack("BBBBBBBBI", fam, 0, 0, 0, 0, 0, 0, 0, 0))',
  "    done = False",
  "    while not done:",
  "        data = s.recv(65536)",
  "        i = 0",
  "        while i < len(data):",
  '            ln, ty = struct.unpack_from("IH", data, i)',
  "            if ty == 3:",
  "                done = True",
  "                break",
  "            if ty == 2:",
  '                raise SystemExit("netlink error %d" % struct.unpack_from("i", data, i + 16)[0])',
  '            f, dl, sl, tos, table, r1, r2, action, flags = struct.unpack_from("BBBBBBBBI", data, i + 16)',
  "            attrs, j = {}, i + 28",
  "            while j + 4 <= i + ln:",
  '                al, at = struct.unpack_from("HH", data, j)',
  "                if al < 4:",
  "                    break",
  "                attrs[str(at & 0x3FFF)] = data[j + 4:j + al].hex()",
  "                j += (al + 3) & ~3",
  '            out.append({"family": name, "table": table, "action": action, "tos": tos, "flags": flags,',
  '                        "src_len": sl, "dst_len": dl, "attrs": attrs})',
  "            i += (ln + 3) & ~3",
  "print(json.dumps(out))",
].join("\n");

// What `docker exec -i <box> node -` runs: the script's source and its call, tsx's `__name` defined (helper.ts).
export const BOX_CHECK =
  `const __name = (f) => f;\n(${String(boxCheck)})(require, process.argv.slice(2), ${JSON.stringify(RULES_PY)});\n`;

// The kernel's standard routing rules, as python3 reads them in a box on the launch's network and on Docker's ordinary
// one (measured 2026-11-18, Docker 29.9.3): local (255), main (254) and default (253) for IPv4, local and main for
// IPv6, each sending every packet to its table. Any other rule, or a change to one of these, stops the launch.
const STANDARD_RULES = [
  [4, 255, { "14": "ffffffff", "15": "ff000000", "21": "02" }],
  [4, 254, { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" }],
  [4, 253, { "6": "ff7f0000", "14": "ffffffff", "15": "fd000000", "21": "02" }],
  [6, 255, { "14": "ffffffff", "15": "ff000000", "21": "02" }],
  [6, 254, { "6": "fe7f0000", "14": "ffffffff", "15": "fe000000", "21": "02" }],
] as const;
const ruleText = (r: Record<string, unknown>) => {
  const attrs = (r.attrs ?? {}) as Record<string, unknown>;
  const sorted = Object.fromEntries(Object.keys(attrs).sort().map((k) => [k, attrs[k]]));
  const { family, table, action, tos, flags, src_len, dst_len } = r;
  return JSON.stringify({ family, table, action, tos, flags, src_len, dst_len, attrs: sorted });
};
const STANDARD = STANDARD_RULES.map(([family, table, attrs]) =>
  ruleText({ family, table, action: 1, tos: 0, flags: 0, src_len: 0, dst_len: 0, attrs }),
).sort();

const v4 = (text: string) => text.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const inside = (address: string, base: number, len: number) =>
  len === 0 || v4(address) >>> (32 - len) === base >>> (32 - len);

// Question 3's IPv4 rule, on /proc/net/fib_trie: only the main and local tables, and in them only routes within the
// network's own block (the box's own address and the block's broadcast among them) or loopback. The trie's inner
// lines (`+-- 0.0.0.0/0 2 0 2`) are in every box; a route is a leaf (`|-- <address>`) and its `/<length> ...` lines.
function trieVerdict(text: string, block: string): "out" | "unread" | undefined {
  const [base, len] = block.split("/") as [string, string];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length || !/^(Main|Local|Id \d+):$/.test(lines[0]!) || !lines.includes("Main:")) return "unread";
  let leaf: string | undefined;
  for (const line of lines) {
    if (/^Id \d+:$/.test(line)) return "out";
    if (/^(Main|Local):$/.test(line)) {
      leaf = undefined;
      continue;
    }
    if (/^\s+\+-- \d{1,3}(\.\d{1,3}){3}\/\d{1,2} \d+ \d+ \d+$/.test(line)) continue;
    const at = /^\s+\|-- (\d{1,3}(?:\.\d{1,3}){3})$/.exec(line);
    if (at) {
      leaf = at[1];
      continue;
    }
    const route = /^\s+\/(\d{1,2}) [a-z]+ [A-Z_]+$/.exec(line);
    if (!route || leaf === undefined) return "unread";
    const length = Number(route[1]);
    const ok = (b: string, l: number) => length >= l && inside(leaf!, v4(b), l);
    if (!ok(base, Number(len)) && !ok("127.0.0.0", 8)) return "out";
  }
  return undefined;
}

// Question 3's IPv6 rule, with the user's answer after Step 1: loopback, link-local and multicast routes, and exactly
// the kernel's own refusal entries for everything as measured (`::/0`, flags 00200200, metric ffffffff, on lo).
function v6Verdict(text: string): "out" | "unread" | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (!lines.length) return "unread"; // a box lists loopback at least (the step's review)
  for (const line of lines) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 10 || !/^[0-9a-f]{32}$/.test(f[0]!) || !/^[0-9a-f]{2}$/.test(f[1]!)) return "unread";
    const [dest, lenHex, , , , metric, , , flags, dev] = f as [string, string, ...string[]];
    const len = parseInt(lenHex, 16);
    const loopback = dest === `${"0".repeat(31)}1` && len === 128;
    const refusal =
      dest === "0".repeat(32) && len === 0 && flags === "00200200" && metric === "ffffffff" && dev === "lo";
    const linkLocal = len >= 10 && (parseInt(dest.slice(0, 3), 16) & 0xffc) === 0xfe8;
    const multicast = len >= 8 && dest.startsWith("ff");
    if (!(loopback || refusal || linkLocal || multicast)) return "out";
  }
  return undefined;
}

// Choice 8: what lets the launch go on (question 3's list, every item), judged here from the raw answers; each failure
// has its W8 ending, and an answer that cannot be read or understood fails (fail closed). One signal, made just before
// the first command, covers the whole check (question 4's check limit).
export async function checkSites(net: SitesNet, box: string, run: DockerRun = docker, limitMs = CHECK_LIMIT_MS) {
  const signal = AbortSignal.timeout(limitMs);
  const late = `the check did not finish within ${limitMs / 1000} s`;
  const cannot = (words: string) => `the check could not run (${words.replace(/\.$/, "")})`;
  const call = async (args: string[], input?: Buffer): Promise<{ fail: string } | { out: string }> => {
    const got = await run(args, { signal, ...(input && { input }) }).catch((e: unknown) => e as Error);
    if (signal.aborted) throw new Late();
    if (got instanceof Error) return { fail: errorText(got) };
    if (got === "missing" || got.code !== 0) return { fail: words(got) };
    return { out: got.out };
  };
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  try {
    const described = await call(["network", "inspect", "--format", "{{json .IPAM.Config}}", net.network]);
    if ("fail" in described) return cannot(described.fail);
    const config = json(described.out) as { Subnet?: string; Gateway?: string }[] | undefined;
    const entries = Array.isArray(config) && config.every((c) => c && typeof c === "object");
    if (!entries) return cannot("Docker's description of the network could not be read");
    if (config.some((c) => c.Gateway)) return "the box's network has a gateway";
    const block = config.map((c) => c.Subnet).find((s) => s && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
    if (!block) return cannot("Docker's description of the network has no IPv4 block");
    const boxed = await call(["inspect", "--format", "{{json .NetworkSettings.Networks}}", box]);
    if ("fail" in boxed) return cannot(boxed.fail);
    const networks = json(boxed.out);
    if (!networks || typeof networks !== "object") return cannot("Docker's description of the box could not be read");
    const joined = Object.keys(networks);
    if (joined.length !== 1 || joined[0] !== net.network) return "the box is joined to another network";
    const exec = ["exec", "-i", box, "node", "-", net.address, String(net.port), net.check];
    const script = await call(exec, Buffer.from(BOX_CHECK));
    if ("fail" in script) return cannot(script.fail);
    const a = json(script.out) as Record<string, Record<string, unknown> | string> | undefined;
    if (!a || typeof a !== "object") return cannot("its answer could not be read");
    const unread = "the box's routes could not be read";
    if (typeof a.fib_trie !== "string" || typeof a.ipv6_route !== "string") return unread;
    const routes = [trieVerdict(a.fib_trie, block), v6Verdict(a.ipv6_route)];
    if (routes.includes("unread")) return unread;
    if (routes.includes("out")) return "the box has a route out";
    const rules = a.rules as { missing?: boolean; text?: string } | undefined;
    if (!rules?.missing) {
      const list = typeof rules?.text === "string" ? json(rules.text) : undefined;
      if (!Array.isArray(list) || !list.every((r) => r && typeof r === "object")) return unread;
      const seen = list.map((r) => ruleText(r as Record<string, unknown>)).sort();
      if (seen.length !== STANDARD.length || seen.some((r, i) => r !== STANDARD[i])) return "the box has a route out";
    }
    const direct = a.direct as { connected?: boolean; error?: string } | undefined;
    if (direct?.connected) return "the box connected straight to an outside address";
    if (direct?.error !== "ENETUNREACH") return "the box has a route out";
    const unlisted = a.unlisted as { status?: string } | undefined;
    if (!unlisted?.status?.startsWith("HTTP/1.1 403 ")) return "the proxy let through a site that is not listed";
    const tunnel = a.tunnel as { status?: string; after?: number } | undefined;
    if (!tunnel?.status?.startsWith("HTTP/1.1 200 ")) {
      return cannot(tunnel?.status || "the check's tunnel was not opened");
    }
    if (tunnel.after !== 0) return "the proxy let through a tunnel that did not open with a TLS greeting";
    const log = await call(["logs", net.proxy]);
    if ("fail" in log) return cannot(log.fail);
    const seen = log.out.split("\n").some((l) => (json(l) as { lookup?: unknown } | undefined)?.lookup === net.check);
    if (!seen) return "the box's lookup did not reach the proxy";
    return undefined;
  } catch (e) {
    if (e instanceof Late) return late;
    throw e;
  }
}

// Decision 1: the proxy's file and its settings, in a new folder of this launch's under the system's temp folder.
function proxyFolder(sites: Site[], check: string): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), "tachikoma-proxy-"));
  atExit.folders.add(folder);
  // This computer's own addresses, read at launch (design review's finding 4).
  const own = Object.values(os.networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address));
  const settings: ProxySettings = { sites, own, check, host: "0.0.0.0", dnsPort: 53 };
  writeFileSync(path.join(folder, "proxy.cjs"), proxyFile());
  writeFileSync(path.join(folder, "settings.json"), JSON.stringify(settings));
  return folder;
}

// Decision 10a: each removal tried once, the box, the proxy, then the network, under one signal of the set-up's length;
// what fails, or is cut off, is named for W15 and left to the next launch's sweep. The folder goes directly.
export async function removeSitesNet(made: Made, run: DockerRun = docker, limitMs = SETUP_LIMIT_MS): Promise<string[]> {
  const { box, proxy, network } = made;
  const steps = [
    box && { name: box.slice(0, 12), args: ["rm", "-f", box], held: atExit.boxes, id: box },
    proxy && { name: proxy, args: ["rm", "-f", proxy], held: atExit.proxies, id: proxy },
    network && { name: network, args: ["network", "rm", network], held: atExit.networks, id: network },
  ].filter((s) => !!s);
  const left: string[] = [];
  if (steps.length) {
    const signal = AbortSignal.timeout(limitMs);
    for (const step of steps) {
      let gone = false;
      if (!signal.aborted) {
        const got = await run(step.args, { signal }).catch(() => undefined);
        // `docker network rm` of a network that is not there says `network <name> not found` and exits 1 (measured
        // 2026-11-18, Docker 29.9.3): nothing is left.
        const absent = !!got && got !== "missing" && got.code !== 0 && /\bnot found\b/.test(got.err);
        gone = !!got && got !== "missing" && (got.code === 0 || absent) && !signal.aborted;
      }
      if (gone) step.held.delete(step.id);
      else left.push(step.name);
    }
  }
  if (made.folder && removeProxyFolder(made.folder)) atExit.folders.delete(made.folder);
  return left;
}
