import { describe, expect, it } from "vitest";
import { rules, SITES_SOURCE, type SitesRules } from "../../src/sandbox/sites.js";

// The same rules as the proxy gets them: rebuilt from the function's source text alone, with tsx's `__name` defined as
// the proxy's file defines it (8c-2b plan, decision 2).
const rebuilt = new Function(`const __name = (f) => f;\nreturn (${SITES_SOURCE})();`)() as SitesRules;

// Decision 4's blocks, written out here as the test's own copy of the table.
const V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "240.0.0.0/4", "255.255.255.255/32", "224.0.0.0/4",
];
const V6 = [
  "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64", "2001::/23", "2001:db8::/32",
  "2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "ff00::/8",
];

const v4n = (t: string) => t.split(".").reduce((n, x) => n * 256n + BigInt(x), 0n);
const v4t = (n: bigint) => [24n, 16n, 8n, 0n].map((s) => String((n >> s) & 255n)).join(".");
function v6n(t: string): bigint {
  const [head, back] = t.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const b = back ? back.split(":") : [];
  const groups = back === undefined ? h : [...h, ...Array<string>(8 - h.length - b.length).fill("0"), ...b];
  return groups.reduce((n, g) => (n << 16n) | BigInt(`0x${g}`), 0n);
}
const v6t = (n: bigint) =>
  Array.from({ length: 8 }, (_, i) => ((n >> BigInt(112 - 16 * i)) & 0xffffn).toString(16)).join(":");
// Each block's first and last address, and the addresses just outside it that exist.
function edges(blocks: string[], bits: number, num: (t: string) => bigint, text: (n: bigint) => string) {
  const spans = blocks.map((b) => {
    const [base, len] = b.split("/") as [string, string];
    const size = 1n << BigInt(bits - Number(len));
    return { lo: num(base), hi: num(base) + size - 1n };
  });
  const top = (1n << BigInt(bits)) - 1n;
  const inside = (n: bigint) => spans.some((s) => n >= s.lo && n <= s.hi);
  return spans.flatMap((s) => [
    { address: text(s.lo), local: true },
    { address: text(s.hi), local: true },
    ...(s.lo > 0n ? [{ address: text(s.lo - 1n), local: inside(s.lo - 1n) }] : []),
    ...(s.hi < top ? [{ address: text(s.hi + 1n), local: inside(s.hi + 1n) }] : []),
  ]);
}

describe.each([
  ["the module", rules],
  ["the function rebuilt from its source text", rebuilt],
] as const)("the allowed sites' rules (%s)", (_, r) => {
  it("an entry allows its name on 443 only, or on its written port only", () => {
    const { sites, left } = r.readList(["github.com", "api.example.com:8443"]);
    expect(left).toEqual([]);
    expect(sites).toEqual([{ name: "github.com", port: 443 }, { name: "api.example.com", port: 8443 }]);
    expect(r.listed(sites, "github.com", 443)).toBe(true);
    expect(r.listed(sites, "api.github.com", 443)).toBe(false); // choice 3
    expect(r.listed(sites, "github.com", 80)).toBe(false);
    expect(r.listed(sites, "api.example.com", 8443)).toBe(true);
    expect(r.listed(sites, "api.example.com", 443)).toBe(false);
    expect(sites.map(r.siteText)).toEqual(["github.com", "api.example.com:8443"]);
    // A name asked for with a port in it is not a name (the step's review).
    expect(r.listed(sites, "github.com:8443", 443)).toBe(false);
    expect(r.listed(sites, "github.com:80", 443)).toBe(false);
    expect(r.hostName("github.com:443")).toBeUndefined();
    expect(r.hostName("[::1]")).toBe("::1");
  });

  it("an IPv4 part written with a leading zero is not read as a public address", () => {
    expect(r.isLocal("012.0.0.1", [])).toBe(true);
    expect(r.isLocal("010.0.0.1", [])).toBe(true);
  });

  it("text after a colon that is not a port leaves the name out of the line", () => {
    expect(r.readList(["user:secret"]).left).toEqual(["allowedSites entry 1 was left out: not a name and port"]);
    expect(r.readList(["github.com:"]).left).toEqual([
      "allowedSites entry 1 (github.com) was left out: not a name and port",
    ]);
  });

  it("letter case and a trailing dot are ignored", () => {
    const { sites, left } = r.readList(["GitHub.com.", "github.com"]);
    expect(left).toEqual([]);
    expect(sites).toEqual([{ name: "github.com", port: 443 }]);
    expect(r.listed(sites, "GITHUB.COM.", 443)).toBe(true);
  });

  it("each refused form is left out with its line", () => {
    const { sites, left } = r.readList([
      "*.github.com", "github.com/releases", "https://github.com", "user:secret@github.com", "localhost:3000",
      "dev.localhost", "10.1.2.3", "93.184.215.14", 42, "github.com:0", "github.com:65536", "exa mple.com", "",
    ]);
    expect(sites).toEqual([]);
    expect(left).toEqual([
      "allowedSites entry 1 (*.github.com) was left out: a wildcard; list each name",
      "allowedSites entry 2 (github.com) was left out: a path",
      "allowedSites entry 3 (github.com) was left out: a scheme in front; write the name and port only",
      "allowedSites entry 4 (github.com) was left out: a password",
      "allowedSites entry 5 (localhost) was left out: a local address",
      "allowedSites entry 6 (dev.localhost) was left out: a local address",
      "allowedSites entry 7 (10.1.2.3) was left out: a local address",
      "allowedSites entry 8 (93.184.215.14) was left out: an IP address; list its name",
      "allowedSites entry 9 was left out: not a name and port",
      "allowedSites entry 10 (github.com) was left out: not a name and port",
      "allowedSites entry 11 (github.com) was left out: not a name and port",
      "allowedSites entry 12 was left out: not a name and port",
      "allowedSites entry 13 was left out: not a name and port",
    ]);
  });

  it("a refused entry's line names only its position and its name", () => {
    const { left } = r.readList(["github.com", "https://someone:hunter2@GitHub.com/org/repo?token=abc123"]);
    expect(left).toEqual(["allowedSites entry 2 (github.com) was left out: a password"]);
    for (const secret of ["someone", "hunter2", "org", "repo", "token", "abc123", "https"]) {
      expect(left[0]).not.toContain(secret);
    }
  });

  it("an entry with several faults gets the first reason in the order", () => {
    const reason = (entry: string) => r.readList([entry]).left[0]?.split(": ").slice(1).join(": ");
    expect(reason("https://u:p@*.github.com/x")).toBe("a password");
    expect(reason("https://*.github.com/x")).toBe("a wildcard; list each name");
    expect(reason("https://github.com/x")).toBe("a path");
    expect(reason("https://localhost")).toBe("a scheme in front; write the name and port only");
    expect(reason("localhost:99999")).toBe("a local address");
    expect(reason("127.0.0.1:99999")).toBe("a local address");
    expect(reason("8.8.8.8:99999")).toBe("an IP address; list its name");
  });

  it("every local range is local", () => {
    for (const { address, local } of [...edges(V4, 32, v4n, v4t), ...edges(V6, 128, v6n, v6t)]) {
      expect([address, r.isLocal(address, [])]).toEqual([address, local]);
    }
    // IPv4 written as IPv6, and IPv6's short forms.
    for (const a of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "::1", "0:0:0:0:0:0:0:1", "fe80::1%eth0"]) {
      expect([a, r.isLocal(a, [])]).toEqual([a, true]);
    }
    // Short IPv4 forms, as entries: the URL standard reads them as 127.0.0.1.
    expect(r.readList(["2130706433", "127.1"]).left).toEqual([
      "allowedSites entry 1 (127.0.0.1) was left out: a local address",
      "allowedSites entry 2 (127.0.0.1) was left out: a local address",
    ]);
    // NAT64 (RFC 6052): local only when the IPv4 address inside is.
    expect(r.isLocal("64:ff9b::127.0.0.1", [])).toBe(true);
    expect(r.isLocal("64:ff9b::7f00:1", [])).toBe(true);
    expect(r.isLocal("64:ff9b::808:808", [])).toBe(false);
    // The computer's own addresses, given as data, public ones included (the design review's finding 4).
    expect(r.isLocal("93.184.215.14", [])).toBe(false);
    expect(r.isLocal("93.184.215.14", ["93.184.215.14"])).toBe(true);
    expect(r.isLocal("64:ff9b::5db8:d70e", ["93.184.215.14"])).toBe(true);
    expect(r.isLocal("2606:4700::1", ["2606:4700:0:0:0:0:0:1"])).toBe(true);
    // Text that is not an address is not trusted.
    expect(r.isLocal("not-an-address", [])).toBe(true);
    expect(r.isLocal("1.2.3.256", [])).toBe(true);
  });

  it("a public address is not local", () => {
    const publics = ["8.8.8.8", "1.1.1.1", "93.184.215.14", "192.31.196.1", "2606:4700:4700::1111", "2620:4f:8000::1"];
    for (const a of publics) {
      expect([a, r.isLocal(a, [])]).toEqual([a, false]);
    }
  });

  it("the same entry written twice counts once, and a name with a port is its own entry", () => {
    const { sites } = r.readList(["example.com:80", "EXAMPLE.com:80", "example.com"]);
    expect(sites).toEqual([{ name: "example.com", port: 80 }, { name: "example.com", port: 443 }]);
  });
});
