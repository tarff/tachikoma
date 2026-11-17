import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../../src/mcp/config.js";
import { answerSetup, helperRuns, type McpSandbox, placeOf, starts } from "../../src/mcp/place.js";

// 8c-2a plan, Task 6 (design, "Where a local server runs"; decision 11): where each server runs, which start with the
// box's network as it is, whether a remote entry's headersHelper runs, and the setup a project's answer is kept for.

const base = { trusted: null, trustedTools: [], alwaysLoad: false, written: "" };
const local = (name: string, over: Partial<ServerConfig> = {}): ServerConfig => {
  const entry = { kind: "stdio" as const, command: "npx", args: [], env: {} };
  return { name, safe: name, where: "user", ...base, entry, asWritten: { command: "npx", args: [] }, ...over };
};
const remote = (name: string, helper?: string, over: Partial<ServerConfig> = {}): ServerConfig => {
  const url = "https://mcp.example.com/mcp";
  const h = helper === undefined ? {} : { headersHelper: helper };
  const entry = { kind: "http" as const, url, headers: {}, ...h };
  return { name, safe: name, where: "user", ...base, entry, asWritten: { url, headers: {}, ...h }, ...over };
};

const SANDBOXES: McpSandbox[] = [
  { kind: "copy", network: "off" },
  { kind: "copy", network: "on" },
  { kind: "live", network: "off" },
  { kind: "live", network: "on" },
];
const project = { where: "project" as const };

describe("placeOf and starts", () => {
  it("runs every server on this computer with no sandbox, and starts each", () => {
    const every = [local("a"), local("h", { host: true }), local("p", project), remote("r"), remote("k", "get-key")];
    for (const c of every) {
      expect(placeOf(c, null)).toBe(c.entry.kind === "stdio" ? "host" : "remote");
      expect(starts(c, null)).toBe(true);
    }
  });

  it("makes a local server a box server with the sandbox on, unless the user's entry says host", () => {
    for (const s of SANDBOXES) {
      expect(placeOf(local("a"), s)).toBe("box");
      expect(placeOf(local("p", project), s)).toBe("box");
      expect(placeOf(local("h", { host: true }), s)).toBe("host");
      expect(placeOf(remote("r"), s)).toBe("remote");
    }
  });

  it("starts only box servers with the network off, and every server with it on", () => {
    for (const s of SANDBOXES) {
      const on = s!.network === "on";
      expect(starts(local("a"), s)).toBe(true);
      expect(starts(local("p", project), s)).toBe(true);
      expect(starts(local("h", { host: true }), s)).toBe(on);
      expect(starts(remote("r"), s)).toBe(on);
      expect(starts(remote("k", "get-key"), s)).toBe(on);
    }
  });
});

describe("helperRuns", () => {
  it("runs a user entry's helper in every setup, and a project's only with no sandbox", () => {
    for (const s of [null, ...SANDBOXES]) {
      expect(helperRuns(remote("k", "get-key"), s)).toBe(true);
      expect(helperRuns(remote("k", "get-key", project), s)).toBe(s === null);
      expect(helperRuns(remote("r"), s)).toBe(false); // no helper to run
      expect(helperRuns(remote("r", undefined, project), s)).toBe(false);
      expect(helperRuns(local("a"), s)).toBe(false);
    }
  });
});

describe("answerSetup", () => {
  it("gives the five local setups, the helper's two and none", () => {
    expect(answerSetup(local("p", project), null)).toBe("host");
    expect(SANDBOXES.map((s) => answerSetup(local("p", project), s))).toEqual([
      "box copy network off",
      "box copy network on",
      "box live network off",
      "box live network on",
    ]);
    expect(answerSetup(local("h", { host: true }), SANDBOXES[0]!)).toBe("host"); // a user's entry: no answer is read
    expect(answerSetup(remote("k", "get-key", project), null)).toBe("helper");
    for (const s of SANDBOXES) expect(answerSetup(remote("k", "get-key", project), s)).toBe("no helper");
    for (const s of [null, ...SANDBOXES]) expect(answerSetup(remote("r", undefined, project), s)).toBeUndefined();
  });
});
