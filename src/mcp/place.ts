import type { ServerConfig } from "./config.js";

// Where each MCP server runs, and what starts (8c-2a plan, Task 6; design, "Where a local server runs"): with the
// sandbox on, a local server runs in the session's box unless the user's own entry says "host", and the box's network
// decides what starts. Tasks 7-10 read these too.

// The sandbox as the servers see it: its kind and the box's network, or null when it is off.
export type McpSandbox = { kind: "live" | "copy"; network: "on" | "off" } | null;

// Remote for a remote entry; in the box with the sandbox on, unless the entry says host; otherwise on this computer.
export function placeOf(c: ServerConfig, s: McpSandbox): "box" | "host" | "remote" {
  if (c.entry.kind !== "stdio") return "remote";
  return s && !c.host ? "box" : "host";
}

// With the box's network off, only a box server starts: outside the box nothing keeps one off the web (choice 3).
export const starts = (c: ServerConfig, s: McpSandbox): boolean => s?.network !== "off" || placeOf(c, s) === "box";

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
