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
