import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { PROXY_SOURCE, proxyFile, type ProxySettings } from "../../src/sandbox/proxy.js";
import { SITES_SOURCE, type Site } from "../../src/sandbox/sites.js";
import { tempDir } from "../helpers.js";

// 8c-2b plan, Step 4: the proxy's own source run by this computer's node in a child process, with the lookup and the
// connect injected (decision 12): the lookup answers from the test's table, and the connect, which records the address
// it was asked for, leads to the test's stand-in on 127.0.0.1 whatever that address is. The rules are never switched
// off. Requests are written as raw bytes, so no client library tidies them first.

const CHECK = "c0ffee.invalid";
const u16 = (n: number) => Buffer.from([(n >> 8) & 255, n & 255]);

// The far side: every byte each connection sends is kept. `echo` sends bytes back; `answers` are http answers, one
// for each whole request head that arrives.
function farSide(mode: { echo: true } | { answers: string[] }) {
  const got: Buffer[] = [];
  let answered = 0;
  let closed = 0;
  const server = net.createServer((s) => {
    const i = got.push(Buffer.alloc(0)) - 1;
    s.on("error", () => {});
    s.on("close", () => closed++);
    s.on("data", (d) => {
      got[i] = Buffer.concat([got[i]!, d]);
      if ("echo" in mode) s.write(d);
      else {
        const heads = got[i]!.toString("latin1").split("\r\n\r\n").length - 1;
        while (answered < heads && answered < mode.answers.length) s.write(mode.answers[answered++]!);
      }
    });
  });
  onTestFinished(() => void server.close());
  return new Promise<{ port: number; got: Buffer[]; bytes: () => number; open: () => number }>((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({
        port: (server.address() as net.AddressInfo).port,
        got,
        bytes: () => got.reduce((n, b) => n + b.length, 0),
        open: () => got.length - closed,
      }),
    ),
  );
}

type Table = Record<string, string[]>;
// The proxy's source with the test's lookup and connect: `table` gives each name's addresses (a name not in it is not
// found), a connect to an address in `fails` is refused, and every lookup and connect is written to stderr.
const HARNESS = `
const __name = (f) => f;
const sitesRules = ${SITES_SOURCE};
const proxy = ${PROXY_SOURCE};
const net = require("node:net");
const [settings, table, far, fails] = JSON.parse(process.argv[2]);
const note = (o) => process.stderr.write(JSON.stringify(o) + "\\n");
proxy(sitesRules(), settings, require, {
  lookup: async (name) => {
    note({ lookup: name });
    if (name.startsWith("slow.")) await new Promise((r) => setTimeout(r, 300));
    if (!table[name]) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return table[name];
  },
  connect: (address, port) => {
    note({ connect: address, port });
    if (fails.includes(address)) {
      const s = new net.Socket();
      process.nextTick(() => s.destroy(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
      return s;
    }
    return net.connect(far, "127.0.0.1");
  },
});
`;

async function startProxy(sites: Site[], table: Table, far: number, fails: string[] = [], own: string[] = []) {
  const settings: ProxySettings = { sites, own, check: CHECK, host: "127.0.0.1", dnsPort: 0 };
  const child = spawn(process.execPath, ["-", JSON.stringify([settings, table, far, fails])], { windowsHide: true });
  onTestFinished(() => void child.kill());
  child.stdin.end(HARNESS);
  const out: string[] = [];
  const notes: Record<string, unknown>[] = [];
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => {
    err += d;
    const lines = err.split("\n");
    err = lines.pop()!;
    for (const l of lines) notes.push(JSON.parse(l) as Record<string, unknown>);
  });
  const first = await new Promise<string>((done, fail) => {
    let text = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      text += d;
      const lines = text.split("\n");
      text = lines.pop()!;
      out.push(...lines);
      if (out.length) done(out[0]!);
    });
    child.on("exit", (code) => fail(new Error(`the proxy ended (${code}): ${err}`)));
  });
  const ports = JSON.parse(first) as { port: number; udp: number; tcp: number };
  const lookups = () => notes.filter((n) => "lookup" in n);
  const connects = () => notes.filter((n) => "connect" in n);
  return { ...ports, out, notes, lookups, connects };
}

// A raw client: what it writes, and everything it gets until the proxy closes, or until `until` holds.
function client(port: number) {
  const s = net.connect(port, "127.0.0.1");
  let got = Buffer.alloc(0);
  let closed = false;
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  s.on("data", (d) => ((got = Buffer.concat([got, d])), wake()));
  s.on("close", () => ((closed = true), wake()));
  s.on("error", () => {});
  onTestFinished(() => void s.destroy());
  return {
    write: (b: string | Buffer) => s.write(b),
    end: () => s.end(),
    text: () => got.toString("latin1"),
    closed: () => closed,
    // Waits until `until` holds for what arrived, or the connection closed.
    wait: async (until: (text: string) => boolean = () => false) => {
      while (!closed && !until(got.toString("latin1"))) await new Promise<void>((w) => waiters.push(w));
      return got.toString("latin1");
    },
  };
}
const head = (t: string) => t.includes("\r\n\r\n");

// A TLS greeting: one handshake record holding one ClientHello, with these server names, and a fault if asked.
function hello(
  names: string[] | null,
  fault: { twoExtensions?: boolean; innerOverrun?: boolean; secondRecord?: boolean } = {},
): Buffer {
  const sni = (list: string[]) => {
    const entries = Buffer.concat(list.map((n) => Buffer.concat([Buffer.from([0]), u16(n.length), Buffer.from(n)])));
    const data = Buffer.concat([u16(entries.length), entries]);
    return Buffer.concat([u16(0), u16(data.length), data]);
  };
  const exts = [Buffer.concat([u16(43), u16(3), Buffer.from([2, 3, 4])])];
  if (names) exts.push(sni(names));
  if (fault.twoExtensions && names) exts.push(sni([names[0]!]));
  const ext = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32, 7), Buffer.from([0]), u16(2), Buffer.from([0x13, 0x01]), Buffer.from([1, 0]),
    u16(ext.length + (fault.innerOverrun ? 9 : 0)), ext,
  ]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  // A greeting that needs a second record: this record carries only its first part.
  const content = fault.secondRecord ? hs.subarray(0, hs.length - 20) : hs;
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(content.length), content]);
}

const GITHUB: Site = { name: "github.com", port: 443 };
const EXAMPLE80: Site = { name: "example.com", port: 80 };
const TABLE: Table = { "github.com": ["140.82.112.3"], "example.com": ["93.184.215.14"] };
const LINE5 = (site: string) => `Tachikoma's sandbox refused ${site}: not on the allowed sites`;
const LOCAL5 = (site: string) => `Tachikoma's sandbox refused ${site}: it points at a local address`;
const W13 = "Tachikoma's sandbox refused the request: its address and its Host header must name one site";
const CONNECT = (target: string, extra = "") => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`;

describe("the proxy: tunnels", () => {
  it("a listed site's tunnel passes once its greeting names it", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    expect(await c.wait(head)).toMatch(/^HTTP\/1\.1 200 /);
    const greeting = hello(["github.com"]);
    c.write(greeting);
    c.write("after the greeting");
    const back = await c.wait((t) => t.endsWith("after the greeting"));
    expect(back.endsWith(greeting.toString("latin1") + "after the greeting")).toBe(true);
    expect(Buffer.concat(far.got).toString("latin1")).toBe(greeting.toString("latin1") + "after the greeting");
    expect(p.connects()).toEqual([{ connect: "140.82.112.3", port: 443 }]);
  });

  it("an unlisted tunnel is refused with line 5, with no lookup made", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write(CONNECT("GitHub.io:443"));
    const got = await c.wait();
    expect(got.startsWith(`HTTP/1.1 403 ${LINE5("github.io:443")}\r\n`)).toBe(true);
    expect(got.endsWith(`\r\n\r\n${LINE5("github.io:443")}`)).toBe(true);
    expect(p.lookups()).toEqual([]);
    expect(far.bytes()).toBe(0);
  });

  it("a listed name that resolves somewhere local is refused with line 5's second form, before any 200", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], { "github.com": ["127.0.0.1"] }, far.port);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    expect((await c.wait()).startsWith(`HTTP/1.1 403 ${LOCAL5("github.com:443")}\r\n`)).toBe(true);
    expect(p.connects()).toEqual([]);
  });

  it("refused when only one of its addresses is local", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], { "github.com": ["140.82.112.3", "10.0.0.5"] }, far.port);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    expect((await c.wait()).startsWith(`HTTP/1.1 403 ${LOCAL5("github.com:443")}\r\n`)).toBe(true);
    expect(p.connects()).toEqual([]);
  });

  it("refused when an address is one of this computer's own", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port, [], ["140.82.112.3"]);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    expect((await c.wait()).startsWith(`HTTP/1.1 403 ${LOCAL5("github.com:443")}\r\n`)).toBe(true);
  });

  it("a listed site that cannot be looked up, or connected to, answers W10 as a 502 before any 200", async () => {
    const far = await farSide({ echo: true });
    const sites = [GITHUB, { name: "broken.example", port: 443 }, { name: "gone.example", port: 443 }];
    const p = await startProxy(sites, { "broken.example": ["140.82.112.9"] }, far.port, ["140.82.112.9"]);
    const a = client(p.port);
    a.write(CONNECT("gone.example:443"));
    const gone = "HTTP/1.1 502 Tachikoma's sandbox could not reach gone.example:443: ENOTFOUND\r\n";
    expect((await a.wait()).startsWith(gone)).toBe(true);
    const b = client(p.port);
    b.write(CONNECT("broken.example:443"));
    expect((await b.wait()).startsWith(
      "HTTP/1.1 502 Tachikoma's sandbox could not reach broken.example:443: ECONNREFUSED\r\n",
    )).toBe(true);
  });

  // The design's Step 1 measurement: pip and urllib send CONNECT as HTTP/1.0 with no Host header (the step's review).
  it("a CONNECT in HTTP/1.0 with no Host header passes as any other", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write("CONNECT github.com:443 HTTP/1.0\r\n\r\n");
    expect(await c.wait(head)).toMatch(/^HTTP\/1\.1 200 /);
    expect(far.bytes()).toBe(0);
    const g = hello(["github.com"]);
    c.write(g);
    await c.wait((t) => t.endsWith(g.toString("latin1")));
    expect(Buffer.concat(far.got).equals(g)).toBe(true);
  });

  it("names an IPv6 target in brackets", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write(CONNECT("[2606:4700::1111]:443"));
    expect((await c.wait()).startsWith(`HTTP/1.1 403 ${LINE5("[2606:4700::1111]:443")}\r\n`)).toBe(true);
  });

  it("a CONNECT's Host header naming another site changes nothing: the target decides", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], { ...TABLE, "evil.example": ["198.51.100.1"] }, far.port);
    const c = client(p.port);
    c.write("CONNECT github.com:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n");
    expect(await c.wait(head)).toMatch(/^HTTP\/1\.1 200 /);
    expect(p.lookups()).toEqual([{ lookup: "github.com" }]);
    const u = client(p.port);
    u.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n");
    expect((await u.wait()).startsWith(`HTTP/1.1 403 ${LINE5("evil.example:443")}`)).toBe(true);
  });

  const closedWithNothing = async (send: (c: ReturnType<typeof client>) => void) => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    await c.wait(head);
    send(c);
    await c.wait();
    expect(c.closed()).toBe(true);
    expect(far.bytes()).toBe(0);
  };
  it("an SSH greeting is closed, nothing sent", () => closedWithNothing((c) => c.write("SSH-2.0-OpenSSH_9.2\r\n")));
  it("a greeting naming another site is closed, nothing sent", () =>
    closedWithNothing((c) => c.write(hello(["api.github.com"]))));
  it("a greeting with no server name is closed, nothing sent", () => closedWithNothing((c) => c.write(hello(null))));
  it("two server-name extensions are closed, nothing sent", () =>
    closedWithNothing((c) => c.write(hello(["github.com"], { twoExtensions: true }))));
  it("one extension with two names is closed, nothing sent", () =>
    closedWithNothing((c) => c.write(hello(["github.com", "github.com"]))));
  it("an inner length that runs past its outer one is closed, nothing sent", () =>
    closedWithNothing((c) => c.write(hello(["github.com"], { innerOverrun: true }))));
  it("a record cut short, then the connection closed, sends nothing", () =>
    closedWithNothing((c) => {
      const g = hello(["github.com"]);
      c.write(g.subarray(0, g.length - 10));
      c.end();
    }));
  it("a record whose declared length is over the limit is closed, nothing sent", () =>
    closedWithNothing((c) => c.write(Buffer.concat([Buffer.from([0x16, 3, 1]), u16(16385), Buffer.alloc(100)]))));
  it("a greeting that needs a second record is closed, nothing sent", () =>
    closedWithNothing((c) => c.write(hello(["github.com"], { secondRecord: true }))));

  it("a greeting split over several writes still passes", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const c = client(p.port);
    c.write(CONNECT("github.com:443"));
    await c.wait(head);
    const g = hello(["github.com"]);
    for (let i = 0; i < g.length; i += 7) {
      c.write(g.subarray(i, i + 7));
      await new Promise((r) => setTimeout(r, 1));
    }
    await c.wait((t) => t.length >= 39 + g.length);
    expect(Buffer.concat(far.got).equals(g)).toBe(true);
  });

  it("a greeting in the same write as the CONNECT still passes, and a bad one sent that way is refused", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const g = hello(["github.com"]);
    const c = client(p.port);
    c.write(Buffer.concat([Buffer.from(CONNECT("github.com:443")), g]));
    await c.wait((t) => t.endsWith(g.toString("latin1")));
    expect(Buffer.concat(far.got).equals(g)).toBe(true);
    const before = far.bytes();
    const bad = client(p.port);
    bad.write(Buffer.concat([Buffer.from(CONNECT("github.com:443")), hello(["other.example"])]));
    await bad.wait();
    expect(bad.closed()).toBe(true);
    expect(far.bytes()).toBe(before);
  });

  // Decision 9: with no lookup and no connection.
  it("the check's name gets its bytes back after a good greeting and is closed after a bad one", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([], TABLE, far.port);
    const good = client(p.port);
    good.write(CONNECT(`${CHECK}:443`));
    expect(await good.wait(head)).toMatch(/^HTTP\/1\.1 200 /);
    const g = hello([CHECK]);
    good.write(g);
    await good.wait((t) => t.endsWith(g.toString("latin1")));
    const bad = client(p.port);
    bad.write(CONNECT(`${CHECK}:443`));
    await bad.wait(head);
    bad.write("SSH-2.0-OpenSSH_9.2\r\n");
    expect(await bad.wait()).not.toContain("SSH-2.0");
    expect(bad.closed()).toBe(true);
    expect(p.lookups()).toEqual([]);
    expect(p.connects()).toEqual([]);
    expect(far.bytes()).toBe(0);
  });
});

const OK = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
// Each answer read in turn on one connection: its head, and a body as long as its Content-Length.
const answers = (n: number) => (t: string) => {
  let count = 0;
  let rest = t;
  while (rest.includes("\r\n\r\n")) {
    const [h, ...more] = rest.split("\r\n\r\n");
    const len = Number(/content-length: (\d+)/i.exec(h!)?.[1] ?? 0);
    const body = more.join("\r\n\r\n");
    if (body.length < len) break;
    rest = body.slice(len);
    count++;
  }
  return count >= n;
};

describe("the proxy: plain http (decision 7a)", () => {
  it("a listed plain http request passes, and the far side sees the Host the proxy wrote", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://Example.com/x?y=1 HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\n\r\n");
    expect(await c.wait(answers(1))).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nok$/);
    const sent = Buffer.concat(far.got).toString("latin1");
    expect(sent.startsWith("GET /x?y=1 HTTP/1.1\r\n")).toBe(true);
    expect(sent).toMatch(/\r\nhost: example\.com\r\n/i);
    expect(sent.toLowerCase()).not.toContain("proxy-connection");
    expect(p.connects()).toEqual([{ connect: "93.184.215.14", port: 80 }]);
  });

  it("an unlisted one is refused with line 5", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n");
    expect((await c.wait(answers(1))).startsWith(`HTTP/1.1 403 ${LINE5("github.com:80")}\r\n`)).toBe(true);
    expect(far.bytes()).toBe(0);
  });

  it("a listed address with a Host header naming an unlisted site is refused with W13, nothing sent", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://example.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n");
    expect((await c.wait(answers(1))).startsWith(`HTTP/1.1 403 ${W13}\r\n`)).toBe(true);
    expect(p.lookups()).toEqual([]);
    expect(far.bytes()).toBe(0);
  });

  it("an unlisted address with a Host header naming a listed site is refused with line 5", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://github.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect((await c.wait(answers(1))).startsWith(`HTTP/1.1 403 ${LINE5("github.com:80")}\r\n`)).toBe(true);
    expect(far.bytes()).toBe(0);
  });

  it("two Host headers are refused with W13, and so is a request without a full address", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const a = client(p.port);
    a.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nHost: example.com\r\n\r\n");
    expect((await a.wait(answers(1))).startsWith(`HTTP/1.1 403 ${W13}\r\n`)).toBe(true);
    const b = client(p.port);
    b.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect((await b.wait(answers(1))).startsWith(`HTTP/1.1 403 ${W13}\r\n`)).toBe(true);
    expect(far.bytes()).toBe(0);
  });

  it("a second request on the same connection is checked afresh", async () => {
    const far = await farSide({ answers: [OK, OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://example.com/1 HTTP/1.1\r\nHost: example.com\r\n\r\n");
    await c.wait(answers(1));
    c.write("GET http://github.com/2 HTTP/1.1\r\nHost: github.com\r\n\r\n");
    expect(await c.wait(answers(2))).toContain(`HTTP/1.1 403 ${LINE5("github.com:80")}\r\n`);
    c.write("GET http://example.com/3 HTTP/1.1\r\nHost: github.com\r\n\r\n");
    expect(await c.wait(answers(3))).toContain(`HTTP/1.1 403 ${W13}\r\n`);
    const sent = Buffer.concat(far.got).toString("latin1");
    expect(sent).toContain("GET /1 ");
    expect(sent).not.toContain("/2 ");
    expect(sent).not.toContain("/3 ");
  });

  it("a redirect is a new request, checked again", async () => {
    const redirect = "HTTP/1.1 302 Found\r\nLocation: http://unlisted.example/\r\nContent-Length: 0\r\n\r\n";
    const far = await farSide({ answers: [redirect] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(await c.wait(answers(1))).toMatch(/^HTTP\/1\.1 302 Found\r\n[\s\S]*location: http:\/\/unlisted\.example\//i);
    c.write("GET http://unlisted.example/ HTTP/1.1\r\nHost: unlisted.example\r\n\r\n");
    expect(await c.wait(answers(2))).toContain(`HTTP/1.1 403 ${LINE5("unlisted.example:80")}\r\n`);
  });

  it("an HTTP/1.0 request with no Host header passes, with the Host the proxy wrote", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write("GET http://example.com/ HTTP/1.0\r\n\r\n");
    expect(await c.wait()).toMatch(/^HTTP\/1\.1 200 OK\r\n[\s\S]*ok$/);
    expect(Buffer.concat(far.got).toString("latin1")).toMatch(/\r\nhost: example\.com\r\n/i);
  });

  // The step's review: a box that goes away while the name is looked up leaves no connection open to the site.
  it("a request whose client leaves during the lookup leaves nothing open on the far side", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([{ name: "slow.example", port: 80 }], { "slow.example": ["93.184.215.14"] }, far.port);
    const c = client(p.port);
    c.write("GET http://slow.example/ HTTP/1.1\r\nHost: slow.example\r\n\r\n");
    await new Promise((r) => setTimeout(r, 50));
    c.end();
    await new Promise((r) => setTimeout(r, 600));
    expect(far.open()).toBe(0);
  });

  it("a request to switch protocols is closed, nothing sent", async () => {
    const far = await farSide({ answers: [OK] });
    const p = await startProxy([EXAMPLE80], TABLE, far.port);
    const c = client(p.port);
    c.write(
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    expect(await c.wait()).not.toContain("101");
    expect(c.closed()).toBe(true);
    expect(p.connects()).toEqual([]);
    expect(far.bytes()).toBe(0);
  });
});

// A lookup question for `name`, type A, as a box's resolver sends it.
const question = (name: string) =>
  Buffer.concat([
    Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...name.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
    Buffer.from([0, 0, 1, 0, 1]),
  ]);

describe("the proxy: lookups and the file", () => {
  // The step's review: a port it cannot listen on is said in its one line, so the launch's W9 can name it.
  it("says why it cannot listen, and ends", async () => {
    const taken = net.createServer();
    await new Promise<void>((done) => taken.listen(0, "127.0.0.1", done));
    onTestFinished(() => void taken.close());
    const dnsPort = (taken.address() as net.AddressInfo).port;
    const settings: ProxySettings = { sites: [], own: [], check: CHECK, host: "127.0.0.1", dnsPort };
    const child = spawn(process.execPath, ["-", JSON.stringify([settings, {}, 1, []])], { windowsHide: true });
    onTestFinished(() => void child.kill());
    child.stdin.end(HARNESS);
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    const code = await new Promise((done) => child.on("exit", done));
    // On Windows the proxy's UDP bind, made before its TCP listen, can get EACCES on a port a TCP listener holds (seen
    // three times in the 8c-2b review), so either code is its line.
    expect([code, out]).toEqual([1, expect.stringMatching(/^\{"error":"(EADDRINUSE|EACCES)"\}\n$/)]);
  });

  it("every lookup is refused, and only the check's name is printed", async () => {
    const far = await farSide({ echo: true });
    const p = await startProxy([GITHUB], TABLE, far.port);
    const udp = dgram.createSocket("udp4");
    onTestFinished(() => void udp.close());
    const ask = (name: string) =>
      new Promise<Buffer>((done) => {
        udp.once("message", done);
        udp.send(question(name), p.udp, "127.0.0.1");
      });
    for (const name of ["github.com", CHECK.toUpperCase(), "example.com"]) {
      const a = await ask(name);
      const got = [name, a.readUInt16BE(0), a[2]! & 0x80, a[3]! & 0x0f, a.readUInt16BE(6)];
      expect(got).toEqual([name, 0x1234, 0x80, 5, 0]);
    }
    const tcp = client(p.tcp);
    const q = question(CHECK);
    tcp.write(Buffer.concat([u16(q.length), q]));
    const t = await tcp.wait((x) => x.length >= 2 && x.length >= 2 + Buffer.from(x, "latin1").readUInt16BE(0));
    expect(Buffer.from(t, "latin1")[5]! & 0x0f).toBe(5);
    await new Promise((r) => setTimeout(r, 50));
    expect(p.out.slice(1)).toEqual([JSON.stringify({ lookup: CHECK }), JSON.stringify({ lookup: CHECK })]);
    expect(p.lookups()).toEqual([]);
  });

  it("the file's text runs alone", async () => {
    const dir = tempDir("tachi-proxy-test-");
    const settings: ProxySettings = { sites: [GITHUB], own: [], check: CHECK, host: "127.0.0.1", dnsPort: 0 };
    writeFileSync(path.join(dir, "proxy.cjs"), proxyFile());
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
    // Not the repo's folder, and no NODE_PATH: only Node's own modules can be found.
    const env = { ...process.env, NODE_PATH: "" };
    const child = spawn(process.execPath, [path.join(dir, "proxy.cjs")], { cwd: dir, env, windowsHide: true });
    const exited = new Promise((done) => child.on("exit", done));
    // Windows keeps a folder that a running process is in, so the folder goes once the proxy has ended.
    onTestFinished(async () => {
      child.kill();
      await exited;
    });
    const first = await new Promise<string>((done, fail) => {
      let t = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        t += d;
        if (t.includes("\n")) done(t.split("\n")[0]!);
      });
      child.on("exit", (code) => fail(new Error(`ended ${code}`)));
    });
    const { port } = JSON.parse(first) as { port: number };
    const c = client(port);
    c.write(CONNECT("pypi.org:443"));
    expect((await c.wait()).startsWith(`HTTP/1.1 403 ${LINE5("pypi.org:443")}\r\n`)).toBe(true);
    expect(proxyFile()).not.toMatch(/require\(["'](?!node:)/);
  });
});
