// The allowed sites' rules, one copy for Tachikoma and for its proxy (8c-2b design, section 3, "One module"; plan,
// Step 2 and decisions 2, 3 and 4): reading the list, matching a name and port exactly, and whether an address is
// local.
// `sitesRules` stands alone, as helper.ts does: it uses nothing from outside the function, not even Node's modules
// (only the URL standard's own reader, a global), so the proxy's file holds its source text (SITES_SOURCE) and runs
// the very same rules. Only types are declared outside it, which go. tsx adds a `__name(...)` call for each named
// function in it, which the proxy's file defines.

export interface Site {
  name: string;
  port: number;
}

export interface SitesRules {
  // The entries in force, each once, and a line for each one left out.
  readList(list: readonly unknown[]): { sites: Site[]; left: string[] };
  // Whether a name and port asked for is on the list, exactly (choice 3).
  listed(sites: readonly Site[], host: string, port: number): boolean;
  // Whether an address is local (decision 4), `own` being the computer's own addresses, read at launch. Text that is
  // not an address counts as local.
  isLocal(address: string, own: readonly string[]): boolean;
  // A name as the rules compare it (lower case, no trailing dot, non-ASCII as the URL standard writes it), or
  // undefined when the text is not a name or an address.
  hostName(text: string): string | undefined;
  // An entry as the user writes it: the name, with its port when it is not 443.
  siteText(site: Site): string;
}

export function sitesRules(): SitesRules {
  // Decision 4: every block of IANA's IPv4 and IPv6 Special-Purpose Address Registries (RFC 6890) whose "Globally
  // Reachable" column is not True, a True entry inside such a block included, and multicast (RFC 5771, RFC 4291).
  // Checked against the registries' files on 2026-11-18 (8c-2b plan, question 7):
  // https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv and
  // https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv. The registries' True
  // blocks outside these (192.31.196.0/24, 192.52.193.0/24, 192.175.48.0/24, 2620:4f:8000::/48) stay public, and
  // 64:ff9b::/96 (RFC 6052) is local only when the IPv4 address in its last 32 bits is.
  const V4 = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "240.0.0.0/4", "255.255.255.255/32", "224.0.0.0/4",
  ];
  const V6 = [
    "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b:1::/48", "100::/64", "100:0:0:1::/64", "2001::/23", "2001:db8::/32",
    "2002::/16", "3fff::/20", "5f00::/16", "fc00::/7", "fe80::/10", "ff00::/8",
  ];
  const NAT64 = "64:ff9b::/96";

  // Dotted IPv4 only, as lookups give it and the URL standard writes it. A part with a leading zero, which other
  // readers take as octal, is not an address, so it counts as local (the step's review).
  function v4(text: string): bigint | undefined {
    const parts = text.split(".");
    if (parts.length !== 4) return undefined;
    let n = 0n;
    for (const p of parts) {
      if (!/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return undefined;
      n = n * 256n + BigInt(p);
    }
    return n;
  }
  // IPv6 with `::`, an IPv4 tail and a zone (`%eth0`), which is dropped.
  function v6(text: string): bigint | undefined {
    let t = text.includes("%") ? text.slice(0, text.indexOf("%")) : text;
    if (t.includes(".")) {
      const at = t.lastIndexOf(":");
      const tail = at < 0 ? undefined : v4(t.slice(at + 1));
      if (tail === undefined) return undefined;
      t = `${t.slice(0, at + 1)}${(tail >> 16n).toString(16)}:${(tail & 0xffffn).toString(16)}`;
    }
    const halves = t.split("::");
    if (halves.length > 2) return undefined;
    const groups = (s: string) => (s === "" ? [] : s.split(":"));
    const head = groups(halves[0]!);
    const back = halves.length === 2 ? groups(halves[1]!) : [];
    const fill = halves.length === 2 ? 8 - head.length - back.length : 0;
    if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
    let n = 0n;
    for (const g of [...head, ...Array<string>(fill).fill("0"), ...back]) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
      n = (n << 16n) | BigInt(`0x${g}`);
    }
    return n;
  }
  type Addr = { bits: number; n: bigint };
  function address(text: string): Addr | undefined {
    const a = v4(text);
    if (a !== undefined) return { bits: 32, n: a };
    const b = v6(text);
    return b === undefined ? undefined : { bits: 128, n: b };
  }
  function block(text: string): Addr & { len: number } {
    const [base, len] = text.split("/") as [string, string];
    return { ...address(base)!, len: Number(len) };
  }
  const within = (a: Addr, b: Addr & { len: number }) =>
    a.bits === b.bits && a.n >> BigInt(a.bits - b.len) === b.n >> BigInt(b.bits - b.len);
  const blocks = [...V4, ...V6].map(block);
  const nat64 = block(NAT64);

  function isLocal(text: string, own: readonly string[]): boolean {
    const a = address(text);
    if (!a) return true;
    const mine = own.map(address).filter((o): o is Addr => o !== undefined);
    const local = (x: Addr) => blocks.some((b) => within(x, b)) || mine.some((o) => o.bits === x.bits && o.n === x.n);
    if (local(a)) return true;
    return within(a, nat64) && local({ bits: 32, n: a.n & 0xffffffffn });
  }

  // Decision 3: a name (or an IP address) read by the URL standard's own host reader, so letter case, a trailing dot,
  // short IPv4 forms and non-ASCII names are settled one way everywhere. An IPv6 address comes back without brackets.
  function hostName(text: string): string | undefined {
    if (typeof text !== "string" || text === "" || /[\s/?#@\\]/.test(text)) return undefined;
    // A port is never part of a name: the URL reader would drop it (the step's review). An IPv6 address comes in
    // brackets.
    if (text.includes(":") && !text.startsWith("[")) return undefined;
    let host: string;
    try {
      host = new URL(`http://${text}/`).hostname;
    } catch {
      return undefined;
    }
    if (host.startsWith("[")) return host.slice(1, -1);
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (v4(host) !== undefined) return host;
    const labels = host.split(".");
    const name = host.length <= 253 && labels.every((l) => /^[a-z0-9_-]{1,63}$/.test(l));
    return name ? host : undefined;
  }

  const siteText = (s: Site) => (s.port === 443 ? s.name : `${s.name}:${s.port}`);

  // One entry: in force, or the reason it is left out with the name part that could be read (choice 11). Reasons are
  // tried in decision 3's order.
  function entry(raw: unknown): { site: Site } | { reason: string; name?: string } {
    if (typeof raw !== "string") return { reason: "not a name and port" };
    let rest = raw.trim();
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
    if (scheme) rest = rest.slice(scheme[0].length);
    const cut = rest.search(/[/?#\\]/);
    const authority = cut < 0 ? rest : rest.slice(0, cut);
    const at = authority.lastIndexOf("@");
    const hostPort = authority.slice(at + 1);
    let host = hostPort;
    let portText = "";
    if (hostPort.startsWith("[")) {
      const close = hostPort.indexOf("]");
      host = close < 0 ? "" : hostPort.slice(0, close + 1);
      portText = close < 0 ? "" : hostPort.slice(close + 1);
    } else if ((hostPort.match(/:/g) ?? []).length === 1) {
      host = hostPort.slice(0, hostPort.indexOf(":"));
      portText = hostPort.slice(hostPort.indexOf(":"));
    } else if (hostPort.includes(":")) {
      host = `[${hostPort}]`; // an IPv6 address written without brackets
    }
    const wildcard = host.includes("*");
    // Text after a colon that is not a port may be a password, so the part before it is not shown either (choice 11).
    const shown = !/^(:\d*)?$/.test(portText)
      ? undefined
      : wildcard
        ? /^[a-z0-9*_.-]+$/i.test(host) ? host.toLowerCase().replace(/\.$/, "") : undefined
        : hostName(host);
    const named = (reason: string) => (shown === undefined ? { reason } : { reason, name: shown });
    if (at >= 0) return named("a password");
    if (wildcard) return named("a wildcard; list each name");
    if (cut >= 0) return named("a path");
    if (scheme) return named("a scheme in front; write the name and port only");
    const ip = shown !== undefined && address(shown) !== undefined;
    if (shown === "localhost" || shown?.endsWith(".localhost") || (ip && isLocal(shown!, []))) {
      return named("a local address");
    }
    if (ip) return named("an IP address; list its name");
    const port = portText === "" ? 443 : /^:\d{1,5}$/.test(portText) ? Number(portText.slice(1)) : 0;
    if (shown === undefined || port < 1 || port > 65535) return named("not a name and port");
    return { site: { name: shown, port } };
  }

  return {
    readList(list) {
      const sites: Site[] = [];
      const left: string[] = [];
      list.forEach((raw, i) => {
        const got = entry(raw);
        if ("site" in got) {
          const s = got.site;
          if (!sites.some((x) => x.name === s.name && x.port === s.port)) sites.push(s);
        } else {
          const name = got.name === undefined ? "" : ` (${got.name})`;
          left.push(`allowedSites entry ${i + 1}${name} was left out: ${got.reason}`);
        }
      });
      return { sites, left };
    },
    listed(sites, host, port) {
      const name = hostName(host);
      return name !== undefined && sites.some((s) => s.name === name && s.port === port);
    },
    isLocal,
    hostName,
    siteText,
  };
}

// For Tachikoma's own use (remote MCP servers, the settings file), made once.
export const rules: SitesRules = sitesRules();

// For the proxy's file (decision 1): the function's source text, as this process was given it.
export const SITES_SOURCE: string = String(sitesRules);
