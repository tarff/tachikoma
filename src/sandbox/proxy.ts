// The sandbox's filtering proxy (8c-2b design, section 2; plan, Step 4 and decisions 1, 5, 7, 7a, 8, 9 and 12). It runs
// in its own container, from the box's image, as one file Tachikoma writes at each launch (proxyFile): the allowed
// sites' rules (sites.ts), this function's own source, and a last line that reads settings.json beside it and starts
// it. So `proxy` stands alone, as helper.ts does: nothing from outside the function but its arguments, Node's modules
// taken from the `require` it is given. Only types are imported, which go; tsx's `__name` is defined by the file.
import type { Socket } from "node:net";
import { SITES_SOURCE, type Site, type SitesRules } from "./sites.js";

// What the proxy's settings file holds: the list, this computer's own addresses (read at launch, design review's
// finding 4), the launch check's made-up name (decision 9), and where it listens: every address of its container, and
// port 53 for lookups (RFC 1035), as the box's --dns sends them there. Tests give 127.0.0.1 and port 0.
export interface ProxySettings {
  sites: Site[];
  own: string[];
  check: string;
  host: string;
  dnsPort: number;
}

// Decision 12: tests give the lookup and the plain TCP connect; the proxy's file never does, so both are Node's there.
export interface ProxyInject {
  lookup?: (name: string) => Promise<string[]>;
  connect?: (address: string, port: number) => Socket;
}

export function proxy(r: SitesRules, settings: ProxySettings, require: NodeJS.Require, inject: ProxyInject = {}): void {
  const net: typeof import("node:net") = require("node:net");
  const http: typeof import("node:http") = require("node:http");
  const dgram: typeof import("node:dgram") = require("node:dgram");
  const dns: typeof import("node:dns") = require("node:dns");
  const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const lookup =
    inject.lookup ?? (async (name: string) => (await dns.promises.lookup(name, { all: true })).map((a) => a.address));
  const connectTo = inject.connect ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const check = settings.check.toLowerCase();
  const code = (e: unknown) => {
    const err = e as { code?: unknown; name?: unknown } | undefined;
    return String(err?.code ?? err?.name ?? "Error");
  };
  // The design's line 5, W10 and W13.
  const notListed = (site: string) => `Tachikoma's sandbox refused ${site}: not on the allowed sites`;
  const pointsLocal = (site: string) => `Tachikoma's sandbox refused ${site}: it points at a local address`;
  const unreached = (site: string, why: string) => `Tachikoma's sandbox could not reach ${site}: ${why}`;
  const ONE_SITE = "Tachikoma's sandbox refused the request: its address and its Host header must name one site";
  // A greeting's record holds at most 2^14 bytes of content (RFC 8446, section 5.1).
  const MAX_RECORD = 16384;

  // A listed name's way out (decisions 5 and 7): the lookup, every address checked, then each tried in order.
  type Reach = { socket: Socket } | { refused: true } | { failed: string };
  async function reach(name: string, port: number): Promise<Reach> {
    let addresses: string[];
    try {
      addresses = await lookup(name);
    } catch (e) {
      return { failed: code(e) };
    }
    if (!addresses.length) return { failed: "ENOTFOUND" };
    if (addresses.some((a) => r.isLocal(a, settings.own))) return { refused: true };
    let last = "ECONNREFUSED";
    for (const address of addresses) {
      const s = connectTo(address, port);
      const why = await new Promise<string | undefined>((done) => {
        s.once("connect", () => done(undefined));
        s.once("error", (e) => done(code(e)));
      });
      if (why === undefined) {
        s.on("error", () => {});
        return { socket: s };
      }
      last = why;
      s.destroy();
    }
    return { failed: last };
  }

  // The one server name of a ClientHello whose every length agrees with the one around it, or undefined (decision 7).
  function helloName(rec: Buffer): string | undefined {
    let i = 0;
    const has = (n: number) => i + n <= rec.length;
    if (!has(4) || rec[0] !== 1 || ((rec[1]! << 16) | (rec[2]! << 8) | rec[3]!) !== rec.length - 4) return undefined;
    i = 4 + 34; // the version and the random
    if (!has(1)) return undefined;
    const session = rec[i]!;
    i += 1;
    if (session > 32 || !has(session + 2)) return undefined;
    i += session;
    const suites = rec.readUInt16BE(i);
    i += 2;
    if (suites < 2 || suites % 2 || !has(suites + 1)) return undefined;
    i += suites;
    const methods = rec[i]!;
    i += 1;
    if (methods < 1 || !has(methods + 2)) return undefined;
    i += methods;
    const all = rec.readUInt16BE(i);
    i += 2;
    if (i + all !== rec.length) return undefined;
    let name: string | undefined;
    let named = false;
    while (i < rec.length) {
      if (!has(4)) return undefined;
      const type = rec.readUInt16BE(i);
      const len = rec.readUInt16BE(i + 2);
      i += 4;
      if (!has(len)) return undefined;
      if (type === 0) {
        if (named) return undefined; // two server-name extensions
        named = true;
        const d = rec.subarray(i, i + len);
        if (d.length < 2 || d.readUInt16BE(0) !== d.length - 2) return undefined;
        const names: { type: number; text: string }[] = [];
        for (let j = 2; j < d.length; ) {
          if (j + 3 > d.length) return undefined;
          const l = d.readUInt16BE(j + 1);
          if (l === 0 || j + 3 + l > d.length) return undefined;
          names.push({ type: d[j]!, text: d.subarray(j + 3, j + 3 + l).toString("latin1") });
          j += 3 + l;
        }
        if (names.length !== 1 || names[0]!.type !== 0) return undefined;
        name = r.hostName(names[0]!.text);
      }
      i += len;
    }
    return name;
  }

  // Reads the tunnel's first record whole, and passes it on only if it is a greeting naming `name`; anything else
  // closes the tunnel with nothing sent on. Bytes that came with the CONNECT request are its start.
  function greeting(socket: Socket, head: Buffer, name: string, pass: (bytes: Buffer) => void, close: () => void) {
    let buf = head;
    const bad = () => {
      socket.off("data", onData);
      socket.destroy();
      close();
    };
    const step = () => {
      if (buf.length < 5) return;
      if (buf[0] !== 0x16 || buf[1] !== 3) return bad();
      const len = buf.readUInt16BE(3);
      if (len > MAX_RECORD) return bad();
      if (buf.length < 5 + len) return;
      socket.off("data", onData);
      socket.off("end", bad);
      socket.pause();
      if (helloName(buf.subarray(5, 5 + len)) === name) pass(buf);
      else bad();
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      step();
    };
    socket.on("data", onData);
    socket.once("end", bad);
    step();
  }

  const answer = (socket: Socket, status: number, line: string) =>
    socket.end(
      `HTTP/1.1 ${status} ${line}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
        `Content-Length: ${Buffer.byteLength(line)}\r\nConnection: close\r\n\r\n${line}`,
    );
  const ESTABLISHED = "HTTP/1.1 200 Connection established\r\n\r\n";

  const server = http.createServer();
  server.on("clientError", (_e, socket) => socket.destroy());
  // Decision 7a: no protocol switch is passed on.
  server.on("upgrade", (_req, socket: Socket) => socket.destroy());

  // A tunnel (decision 7): only the request's target names the site; its Host header is not read.
  server.on("connect", (req: import("node:http").IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on("error", () => {});
    const target = req.url ?? "";
    const m = /^(.+):(\d{1,5})$/.exec(target);
    const host = m ? m[1]! : target;
    const port = m ? Number(m[2]) : 0;
    const name = r.hostName(host);
    const shown = m ? `${name?.includes(":") ? `[${name}]` : (name ?? host)}:${port}` : target;
    // Decision 9: the launch check's name on 443, with an empty list too: nothing looked up, nothing reached; a good
    // greeting comes back as it was sent.
    if (name === check && port === 443) {
      socket.write(ESTABLISHED);
      return greeting(socket, head, name, (bytes) => {
        socket.write(bytes);
        socket.pipe(socket);
      }, () => {});
    }
    if (name === undefined || !r.listed(settings.sites, host, port)) return answer(socket, 403, notListed(shown));
    void reach(name, port).then((got) => {
      if ("refused" in got) return answer(socket, 403, pointsLocal(shown));
      if ("failed" in got) return answer(socket, 502, unreached(shown, got.failed));
      const up = got.socket;
      if (socket.destroyed) return up.destroy();
      socket.on("close", () => up.destroy());
      up.on("close", () => socket.destroy());
      socket.write(ESTABLISHED);
      greeting(socket, head, name, (bytes) => {
        up.write(bytes);
        socket.pipe(up);
        up.pipe(socket);
      }, () => up.destroy());
    });
  });

  // Plain http (decision 7a): one site per request, named by its full address alone, each request checked afresh.
  const DROPPED = ["host", "proxy-connection", "proxy-authorization", "connection", "keep-alive"];
  server.on("request", (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const refuse = (status: number, line: string) => {
      const type = "text/plain; charset=utf-8";
      res.writeHead(status, line, { "Content-Type": type, "Content-Length": Buffer.byteLength(line) });
      res.end(line);
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      return refuse(403, ONE_SITE);
    }
    if (url.protocol !== "http:" || url.username || url.password) return refuse(403, ONE_SITE);
    const port = Number(url.port || 80);
    const name = r.hostName(url.hostname);
    if (name === undefined || !r.listed(settings.sites, url.hostname, port)) {
      return refuse(403, notListed(`${name ?? url.hostname}:${port}`));
    }
    const hosts: string[] = [];
    for (let k = 0; k < req.rawHeaders.length; k += 2) {
      if (req.rawHeaders[k]!.toLowerCase() === "host") hosts.push(req.rawHeaders[k + 1]!);
    }
    if (hosts.length > 1) return refuse(403, ONE_SITE);
    if (hosts.length === 1) {
      const h = /^([^\s/?#@\\]+?)(?::(\d{1,5}))?$/.exec(hosts[0]!);
      if (!h || r.hostName(h[1]!) !== name || Number(h[2] ?? 80) !== port) return refuse(403, ONE_SITE);
    }
    if (req.headers.upgrade !== undefined) return void req.socket.destroy();
    const shown = `${name}:${port}`;
    // A client that leaves while the name is looked up leaves nothing open to the site (the step's review).
    let gone = false;
    res.on("close", () => (gone = true));
    void reach(name, port).then((got) => {
      if ("socket" in got && gone) return got.socket.destroy();
      if ("refused" in got) return refuse(403, pointsLocal(shown));
      if ("failed" in got) return refuse(502, unreached(shown, got.failed));
      const socket = got.socket;
      const headers: string[] = ["Host", port === 80 ? name : `${name}:${port}`];
      for (let k = 0; k < req.rawHeaders.length; k += 2) {
        const key = req.rawHeaders[k]!;
        if (!DROPPED.includes(key.toLowerCase())) headers.push(key, req.rawHeaders[k + 1]!);
      }
      const path = url.pathname + url.search;
      const up = http.request({ method: req.method, path, headers, createConnection: () => socket });
      up.on("response", (answer) => {
        const back: string[] = [];
        for (let k = 0; k < answer.rawHeaders.length; k += 2) {
          const key = answer.rawHeaders[k]!.toLowerCase();
          if (key !== "connection" && key !== "keep-alive") back.push(answer.rawHeaders[k]!, answer.rawHeaders[k + 1]!);
        }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, back);
        answer.pipe(res);
      });
      up.on("error", (e) => (res.headersSent ? res.destroy() : refuse(502, unreached(shown, code(e)))));
      res.on("close", () => up.destroy());
      req.pipe(up);
    });
  });

  // Lookups (decision 8): every question refused (RCODE 5, RFC 1035 section 4.1.1); a line only for the check's name.
  function refusal(q: Buffer): Buffer | undefined {
    if (q.length < 12 || q.readUInt16BE(4) !== 1) return undefined;
    const labels: string[] = [];
    let i = 12;
    while (i < q.length && q[i] !== 0) {
      if (q[i]! & 0xc0) return undefined;
      labels.push(q.subarray(i + 1, i + 1 + q[i]!).toString("latin1"));
      i += q[i]! + 1;
    }
    if (i + 5 > q.length) return undefined;
    if (labels.join(".").toLowerCase() === check) say({ lookup: settings.check });
    const a = Buffer.from(q.subarray(0, i + 5)); // the header and the one question
    a[2] = 0x80 | (q[2]! & 0x79); // an answer, with the question's opcode and recursion flag
    a[3] = 5;
    a.writeUInt16BE(0, 6);
    a.writeUInt16BE(0, 8);
    a.writeUInt16BE(0, 10);
    return a;
  }
  const udp = dgram.createSocket("udp4");
  udp.on("error", () => {});
  udp.on("message", (q, from) => {
    const a = refusal(q);
    if (a) udp.send(a, from.port, from.address);
  });
  // Docker's resolver passes a question on the way it came, so TCP as well (8c-2b plan, Step 1's measurement).
  const tcp = net.createServer((s) => {
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const a = refusal(buf.subarray(2, 2 + buf.readUInt16BE(0)));
        buf = buf.subarray(2 + buf.readUInt16BE(0));
        if (a) s.write(Buffer.concat([Buffer.from([a.length >> 8, a.length & 255]), a]));
      }
    });
  });

  // Decision 6: the first output line, once all three listen, says the port the system gave.
  let up = 0;
  const ready = () => {
    if (++up < 3) return;
    const p = (x: unknown) => (x as { port: number }).port;
    say({ port: p(server.address()), udp: p(udp.address()), tcp: p(tcp.address()) });
  };
  // A port it cannot listen on is its one line, and it ends, so the launch can say why (W9; the step's review).
  let listening = true;
  const cannot = (e: unknown) => {
    if (!listening) return;
    listening = false;
    say({ error: code(e) });
    process.exit(1);
  };
  server.once("error", cannot);
  tcp.once("error", cannot);
  udp.removeAllListeners("error");
  udp.once("error", cannot);
  server.listen(0, settings.host, ready);
  udp.bind(settings.dnsPort, settings.host, () => (udp.on("error", () => {}), ready()));
  tcp.listen(settings.dnsPort, settings.host, ready);
}

// The proxy's source text, as this process was given it.
export const PROXY_SOURCE: string = String(proxy);

// The file the proxy's container runs (decision 1): the rules, the proxy, and the line that starts it with the settings
// file beside it.
export function proxyFile(): string {
  return [
    '"use strict";',
    "// Tachikoma's sandbox proxy (8c-2b plan, Step 4): written at each launch, read-only in its own container.",
    "const __name = (f) => f;",
    `const sitesRules = ${SITES_SOURCE};`,
    `const proxy = ${PROXY_SOURCE};`,
    'const read = require("node:fs").readFileSync(require("node:path").join(__dirname, "settings.json"), "utf8");',
    "proxy(sitesRules(), JSON.parse(read), require);",
    "",
  ].join("\n");
}
