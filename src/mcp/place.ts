import net from "node:net";
import { rules, type Site } from "../sandbox/sites.js";
import type { ServerConfig } from "./config.js";

// Where each MCP server runs, and what starts (8c-2a plan, Task 6; design, "Where a local server runs"): with the
// sandbox on, a local server runs in the session's box unless the user's own entry says "host", and the box's network
// decides what starts. Tasks 7-10 read these too.

// The sandbox as the servers see it: its kind and the box's network, with the entries in force when the network is
// "sites" (8c-2b plan, Step 9), or null when it is off.
export type McpSandbox =
  | { kind: "live" | "copy"; network: "on" | "off" }
  | { kind: "live" | "copy"; network: "sites"; sites: Site[] }
  | null;

// /mcp's words for an off server after "off: ": the box's network off, which State's `off` gives with no reason.
export const NETWORK_OFF = "the sandbox's network is off";
// A host server's with the allowed sites (W4).
export const HOST_OFF = "the sandbox's network is limited to its allowed sites";

// Why a server is off, as /mcp's row says it after "off: ", or undefined when it starts. With the box's network off,
// only a box server starts: outside the box nothing keeps one off the web (choice 3). With the allowed sites (8c-2b
// design, section 4's table; plan, decision 13), a box server starts, a host one is off (W4), and a remote one starts
// only when its address's name and port are listed and its address is not written as a local one; a listed name that
// later resolves somewhere local is refused by its checked fetch (sitesFetch.ts).
export function offReason(c: ServerConfig, s: McpSandbox): string | undefined {
  if (!s || s.network === "on" || placeOf(c, s) === "box") return undefined;
  if (s.network !== "sites") return NETWORK_OFF;
  if (c.entry.kind === "stdio") return HOST_OFF;
  const url = new URL(c.entry.url);
  const name = rules.hostName(url.hostname);
  // As an entry's "a local address" is read (sites.ts): localhost, a name ending .localhost (RFC 6761), a local IP.
  const ip = name !== undefined && net.isIP(name) !== 0;
  const local = name === "localhost" || name?.endsWith(".localhost") || (ip && rules.isLocal(name!, []));
  if (local) return "a local address";
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return rules.listed(s.sites, url.hostname, port) ? undefined : "not on the allowed sites";
}

// Remote for a remote entry; in the box with the sandbox on, unless the entry says host; otherwise on this computer.
export function placeOf(c: ServerConfig, s: McpSandbox): "box" | "host" | "remote" {
  if (c.entry.kind !== "stdio") return "remote";
  return s && !c.host ? "box" : "host";
}

// Whether a server starts: it has no reason to be off (offReason).
export const starts = (c: ServerConfig, s: McpSandbox): boolean => offReason(c, s) === undefined;

// A remote entry's headersHelper runs from the user's file, or from a project's with no sandbox: nothing from the
// project runs on this computer while the sandbox is on (design, choice 3).
export const helperRuns = (c: ServerConfig, s: McpSandbox): boolean =>
  c.entry.kind !== "stdio" && c.entry.headersHelper !== undefined && (c.where === "user" || s === null);

// The setup a project's answer is kept for (decision 11): `host`, or `box <kind> network <network>`, for a local
// server; `helper` or `no helper` for a remote entry with a helper; none for one without.
export function answerSetup(c: ServerConfig, s: McpSandbox): string | undefined {
  const place = placeOf(c, s);
  if (place === "box") return `box ${s!.kind} network ${s!.network}`;
  if (place === "host") return "host";
  if (c.entry.kind !== "stdio" && c.entry.headersHelper !== undefined) return helperRuns(c, s) ? "helper" : "no helper";
  return undefined;
}
