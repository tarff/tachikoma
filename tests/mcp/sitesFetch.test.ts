import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { SiteRefused, sitesFetch } from "../../src/mcp/sitesFetch.js";
import type { Site } from "../../src/sandbox/sites.js";
import { certificate } from "./cert.js";

// 8c-2b plan, Step 8: Tachikoma's own requests to a remote MCP server under the allowed sites, against stand-ins on
// 127.0.0.1 reached through the injected lookup and connect (decision 12): the lookup answers public addresses and the
// connect, which records the address it was asked for, leads to the stand-in whatever the address.

const PUBLIC = "93.184.215.14";
const W5 = (site: string) =>
  `${site} is not on the allowed sites; add it to "allowedSites" in ~/.tachikoma/settings.json`;
const LOCAL = (site: string) => `${site} points at a local address`;
const W14 = (enc: string) =>
  `the server sent a compressed answer (${enc}), which Tachikoma does not read with the allowed sites in force`;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
async function standIn(handler: Handler, tls?: { key: string; cert: string }) {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const onRequest: Handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      handler(req, res);
    });
  };
  const server = tls ? https.createServer(tls, onRequest) : http.createServer(onRequest);
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return { port: (server.address() as net.AddressInfo).port, seen, sockets };
}

// A checked fetch for `sites`, its lookup from `table` and its connect to the stand-in, recording both.
function made(
  sites: Site[],
  port: number,
  table: Record<string, string[]> = {},
  extra: Partial<Parameters<typeof sitesFetch>[0]> = {},
) {
  const lookups: string[] = [];
  const connects: string[] = [];
  const refusals: Error[] = [];
  const fetch = sitesFetch({
    sites,
    own: [],
    refused: (e) => refusals.push(e),
    lookup: async (name) => {
      lookups.push(name);
      const got = table[name] ?? [PUBLIC];
      if (!got.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      return got;
    },
    connect: (address, p) => {
      connects.push(`${address}:${p}`);
      return net.connect(port, "127.0.0.1");
    },
    ...extra,
  });
  return { fetch, lookups, connects, refusals };
}
const SITE: Site = { name: "mcp.example", port: 8080 };
const URL_ = "http://mcp.example:8080/mcp";
const json = (res: http.ServerResponse, body: unknown, status = 200) =>
  (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(body)));

describe("the checked fetch: the check", () => {
  it("connects to the address it checked", async () => {
    const s = await standIn((_, res) => json(res, { ok: true }));
    const f = made([SITE], s.port, { "mcp.example": ["93.184.215.9"] });
    const res = await f.fetch(URL_);
    expect(await res.json()).toEqual({ ok: true });
    expect(f.connects).toEqual(["93.184.215.9:8080"]);
    expect(s.seen[0]!.headers.host).toBe("mcp.example:8080");
  });

  it("an unlisted name is refused before any lookup, the owner hearing it; a listed name on another port", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const a = made([SITE], s.port);
    await expect(a.fetch("https://other.example/mcp")).rejects.toThrow(new SiteRefused(W5("other.example:443")));
    expect(a.lookups).toEqual([]);
    expect(a.refusals.map((e) => e.message)).toEqual([W5("other.example:443")]);
    const b = made([SITE], s.port);
    await expect(b.fetch("http://mcp.example:9090/mcp")).rejects.toThrow(W5("mcp.example:9090"));
  });

  it("a listed name that resolves somewhere local is refused, nothing sent; and when one of two is", async () => {
    const s = await standIn((_, res) => json(res, {}));
    for (const addresses of [["127.0.0.1"], [PUBLIC, "10.0.0.7"]]) {
      const f = made([SITE], s.port, { "mcp.example": addresses });
      await expect(f.fetch(URL_)).rejects.toThrow(LOCAL("mcp.example:8080"));
      expect(f.connects).toEqual([]);
    }
    expect(s.seen).toEqual([]);
  });

  it("a name that changes where it points is caught", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const table = { "mcp.example": [PUBLIC] };
    const f = made([SITE], s.port, table);
    await (await f.fetch(URL_)).text();
    table["mcp.example"] = ["192.168.1.5"];
    await expect(f.fetch(URL_)).rejects.toThrow(LOCAL("mcp.example:8080"));
  });

  it("a redirect is returned, not followed, and the follow-up call to an unlisted address is refused", async () => {
    const s = await standIn((_, res) => (res.writeHead(302, { Location: "https://evil.example/x" }), res.end()));
    const f = made([SITE], s.port);
    const res = await f.fetch(URL_, { redirect: "manual" });
    expect([res.status, res.headers.get("location")]).toEqual([302, "https://evil.example/x"]);
    const plain = await f.fetch(URL_);
    expect(plain.status).toBe(302);
    await expect(f.fetch("https://evil.example/x")).rejects.toThrow(W5("evil.example:443"));
    expect(s.seen).toHaveLength(2);
  });
});

describe("the checked fetch: after the first refusal (decision 13a)", () => {
  it("refuses a listed address too, no lookup, no connection, the first reason kept and said once", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const f = made([SITE], s.port, { "mcp.example": [PUBLIC] });
    await expect(f.fetch("https://other.example/")).rejects.toThrow(W5("other.example:443"));
    await expect(f.fetch(URL_)).rejects.toThrow(W5("other.example:443"));
    await expect(f.fetch("http://mcp.example:7/")).rejects.toThrow(W5("other.example:443"));
    expect([f.lookups, f.connects, f.refusals.length]).toEqual([[], [], 1]);
  });

  it("two made from the same list do not share a refusal", async () => {
    const s = await standIn((_, res) => json(res, { ok: 1 }));
    const a = made([SITE], s.port);
    const b = made([SITE], s.port);
    await expect(a.fetch("https://other.example/")).rejects.toThrow(SiteRefused);
    expect((await b.fetch(URL_)).status).toBe(200);
  });

  it("a request already under way when the refusal came is left to finish", async () => {
    let answer: (() => void) | undefined;
    const s = await standIn((_, res) => (answer = () => json(res, { late: true })));
    const f = made([SITE], s.port);
    const first = f.fetch(URL_);
    while (!answer) await new Promise((r) => setTimeout(r, 5));
    await expect(f.fetch("https://other.example/")).rejects.toThrow(SiteRefused);
    answer();
    expect(await (await first).json()).toEqual({ late: true });
  });
});

describe("the checked fetch: https, end to end", () => {
  it("a certificate for the requested name is accepted, the name in the greeting and in Host", async () => {
    const c = certificate("mcp.example");
    let servername: string | undefined;
    const s = await standIn((req, res) => {
      servername = (req.socket as import("node:tls").TLSSocket).servername || undefined;
      json(res, { secure: true });
    }, c);
    const f = made([{ name: "mcp.example", port: 443 }], s.port, {}, { ca: [c.cert] });
    const res = await f.fetch("https://mcp.example/mcp");
    expect(await res.json()).toEqual({ secure: true });
    expect([servername, s.seen[0]!.headers.host]).toEqual(["mcp.example", "mcp.example"]);
  });

  it("a certificate for another name fails, and one nobody vouched for fails; neither sends the request", async () => {
    const other = certificate("other.example");
    const s = await standIn((_, res) => json(res, {}), other);
    const site = [{ name: "mcp.example", port: 443 }];
    await expect(made(site, s.port, {}, { ca: [other.cert] }).fetch("https://mcp.example/")).rejects.toThrow(TypeError);
    await expect(made(site, s.port).fetch("https://mcp.example/")).rejects.toThrow(TypeError);
    expect(s.seen).toEqual([]);
  });

  it("with the proxy variables set as Step 1 measured them, the request still goes to the checked address", {
    timeout: 30_000, // a child Node through tsx, a test's own limit
  }, async () => {
    // A child Node with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY at a listener that only counts what reaches it.
    let proxied = 0;
    const trap = net.createServer((c) => (proxied++, c.destroy()));
    await new Promise<void>((done) => trap.listen(0, "127.0.0.1", done));
    onTestFinished(() => void trap.close());
    const s = await standIn((_, res) => json(res, { direct: true }));
    const root = path.resolve(import.meta.dirname, "../..");
    const script = [
      'import net from "node:net";',
      'import { sitesFetch } from "./src/mcp/sitesFetch.ts";',
      'const f = sitesFetch({ sites: [{ name: "mcp.example", port: 8080 }], own: [],',
      `  lookup: async () => ["${PUBLIC}"],`,
      `  connect: () => net.connect(${s.port}, "127.0.0.1") });`,
      `void f("${URL_}").then((r) => r.text()).then((t) => process.stdout.write(t));`,
    ].join("\n");
    const proxy = `http://127.0.0.1:${(trap.address() as net.AddressInfo).port}`;
    const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxy, HTTP_PROXY: proxy };
    const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
    const printed = await new Promise<string>((done, fail) => {
      const child = spawn(process.execPath, [tsx, "-e", script], { cwd: root, env, windowsHide: true });
      let o = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (o += d));
      child.on("error", fail);
      child.on("close", () => done(o));
    });
    expect([printed, proxied]).toEqual(['{"direct":true}', 0]);
  });
});

describe("the checked fetch: the contract (decision 17)", () => {
  it("a JSON POST's body arrives, and a URLSearchParams body arrives as a form, with its content type", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const f = made([SITE], s.port);
    await f.fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"a":1}' });
    const form = new URLSearchParams({ grant_type: "authorization_code", code: "x y" });
    await f.fetch(URL_, { method: "POST", body: form });
    await f.fetch(URL_, { method: "POST", body: new TextEncoder().encode("bytes") });
    expect(s.seen.map((r) => [r.method, r.headers["content-type"], r.body])).toEqual([
      ["POST", "application/json", '{"a":1}'],
      ["POST", "application/x-www-form-urlencoded;charset=UTF-8", "grant_type=authorization_code&code=x+y"],
      ["POST", undefined, "bytes"],
    ]);
  });

  it("a body of another kind is an error", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const body = new ReadableStream() as unknown as BodyInit;
    const refused = made([SITE], s.port).fetch(URL_, { method: "POST", body });
    await expect(refused).rejects.toThrow("this request's body is not text, a form or bytes");
    expect(s.seen).toEqual([]);
  });

  // The step's review.
  it("a text body gets fetch's own content type when it has none", async () => {
    const s = await standIn((_, res) => json(res, {}));
    await made([SITE], s.port).fetch(URL_, { method: "POST", body: "hi" });
    expect(s.seen[0]!.headers["content-type"]).toBe("text/plain;charset=UTF-8");
  });

  it("an answer with a status fetch cannot give is a TypeError, and nothing ends", async () => {
    const s = await standIn((_, res) => (res.writeHead(600), res.end()));
    await expect(made([SITE], s.port).fetch(URL_)).rejects.toThrow(TypeError);
  });

  it("a refusal that comes while another request looks its name up stays the first, said once", async () => {
    const s = await standIn((_, res) => json(res, {}));
    let release: (() => void) | undefined;
    const f = made([SITE], s.port, {}, {
      lookup: () => new Promise((done) => (release = () => done(["127.0.0.1"]))),
    });
    const a = f.fetch(URL_);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await expect(f.fetch("https://other.example/")).rejects.toThrow(W5("other.example:443"));
    release();
    await expect(a).rejects.toThrow(W5("other.example:443"));
    expect(f.refusals.map((e) => e.message)).toEqual([W5("other.example:443")]);
  });

  it("an abort while the name is looked up leaves no connection open", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const stop = new AbortController();
    const f = made([SITE], s.port, {}, {
      lookup: async () => (stop.abort(new Error("stopped")), [PUBLIC]),
    });
    await expect(f.fetch(URL_, { signal: stop.signal })).rejects.toThrow("stopped");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.sockets.size).toBe(0);
  });

  it("a body cut in the middle is a TypeError, as Node's fetch gives it", async () => {
    const s = await standIn((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n", () => setTimeout(() => req.socket.destroy(), 20));
    });
    const reader = (await made([SITE], s.port).fetch(URL_)).body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow(TypeError);
  });

  it("names an IPv6 address in brackets when it refuses it", async () => {
    await expect(made([SITE], 1).fetch("http://[2606:4700::1111]:8080/")).rejects.toThrow(
      W5("[2606:4700::1111]:8080"),
    );
  });

  it("status, headers and a JSON body come back; a streamed body is read piece by piece", async () => {
    const s = await standIn((req, res) => {
      if (req.url === "/json") return json(res, { a: 1 }, 201);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 50);
    });
    const f = made([SITE], s.port);
    const a = await f.fetch("http://mcp.example:8080/json");
    expect([a.status, a.headers.get("content-type"), await a.json()]).toEqual([201, "application/json", { a: 1 }]);
    const b = await f.fetch("http://mcp.example:8080/events");
    const reader = b.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("data: one\n\n");
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe("data: two\n\n");
  });

  it("204, 205, 304 and a HEAD answer have no body", async () => {
    const s = await standIn((req, res) => (res.writeHead(Number(req.url!.slice(1)) || 200), res.end()));
    const f = made([SITE], s.port);
    for (const code of [204, 205, 304]) expect((await f.fetch(`http://mcp.example:8080/${code}`)).body).toBeNull();
    expect((await f.fetch("http://mcp.example:8080/", { method: "HEAD" })).body).toBeNull();
  });

  it('redirect: "error" fails on a redirect; the default and manual give it back', async () => {
    const s = await standIn((_, res) => (res.writeHead(307, { Location: "/elsewhere" }), res.end()));
    const f = made([SITE], s.port);
    await expect(f.fetch(URL_, { redirect: "error" })).rejects.toThrow(TypeError);
    expect((await f.fetch(URL_)).status).toBe(307);
    expect((await f.fetch(URL_, { redirect: "manual" })).status).toBe(307);
  });

  // src/mcp/server.ts: isDrop is a TypeError, and notReached finds ECONNREFUSED in its cause chain.
  const causes = (e: unknown) => {
    const codes: unknown[] = [];
    for (let c = (e as Error).cause; c instanceof Error; c = c.cause) codes.push((c as NodeJS.ErrnoException).code);
    return codes;
  };
  it("a refused connection is a TypeError whose cause has ECONNREFUSED, as with Node's fetch", async () => {
    const closed = net.createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((done) => closed.close(done));
    const ours = await made([SITE], port).fetch(URL_).catch((e: unknown) => e);
    const node = await fetch(`http://127.0.0.1:${port}/`).catch((e: unknown) => e);
    for (const e of [ours, node]) {
      expect(e).toBeInstanceOf(TypeError);
      expect(causes(e)).toContain("ECONNREFUSED");
    }
  });

  it("a connection cut after the request was sent is a TypeError without it, as with Node's fetch", async () => {
    const s = await standIn((req) => req.socket.destroy());
    const ours = await made([SITE], s.port).fetch(URL_).catch((e: unknown) => e);
    const node = await fetch(`http://127.0.0.1:${s.port}/`).catch((e: unknown) => e);
    for (const e of [ours, node]) {
      expect(e).toBeInstanceOf(TypeError);
      expect(causes(e)).not.toContain("ECONNREFUSED");
    }
  });

  it("an abort before the answer ends the request; after the headers, the body and the connection", async () => {
    const s = await standIn((req, res) => {
      if (req.url === "/slow") return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: one\n\n");
    });
    const f = made([SITE], s.port);
    const early = new AbortController();
    const pending = f.fetch("http://mcp.example:8080/slow", { signal: early.signal });
    while (s.seen.length < 1) await new Promise((r) => setTimeout(r, 5));
    early.abort(new Error("stop now"));
    await expect(pending).rejects.toThrow("stop now");
    const late = new AbortController();
    const res = await f.fetch("http://mcp.example:8080/stream", { signal: late.signal });
    const reader = res.body!.getReader();
    await reader.read();
    late.abort(new Error("stop the stream"));
    await expect(reader.read()).rejects.toThrow("stop the stream");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.sockets.size).toBe(0);
  });

  it("a site refusal is not a TypeError", async () => {
    const e = await made([SITE], 1).fetch("https://other.example/").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SiteRefused);
    expect(e).not.toBeInstanceOf(TypeError);
  });

  it("every request carries Accept-Encoding: identity, a caller's own value replaced", async () => {
    const s = await standIn((_, res) => json(res, {}));
    const f = made([SITE], s.port);
    await f.fetch(URL_, { headers: { "Accept-Encoding": "gzip, br" } });
    expect(s.seen[0]!.headers["accept-encoding"]).toBe("identity");
  });

  it("an answer marked gzip fails with W14 naming gzip, unread and closed, for JSON or a stream", async () => {
    for (const type of ["application/json", "text/event-stream"]) {
      const s = await standIn((_, res) => {
        res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip" });
        res.write("x");
      });
      const f = made([SITE], s.port);
      const e = await f.fetch(URL_).catch((x: unknown) => x);
      expect(e).toEqual(new SiteRefused(W14("gzip")));
      expect(e).not.toBeInstanceOf(TypeError);
      await new Promise((r) => setTimeout(r, 50));
      expect(s.sockets.size).toBe(0);
    }
  });

  // The user's decision after Step 8 (2026-11-18): a compressed answer fails that one request only. It is not a
  // refusal of the site, so it does not end the attempt (decision 13a) and the owner is not told.
  it("after a compressed answer the next request on the same fetch still goes through", async () => {
    const s = await standIn((req, res) =>
      req.url === "/gz" ? (res.writeHead(200, { "Content-Encoding": "gzip" }), res.end("x")) : json(res, { ok: 1 }));
    const f = made([SITE], s.port);
    await expect(f.fetch("http://mcp.example:8080/gz")).rejects.toThrow(W14("gzip"));
    expect(await (await f.fetch(URL_)).json()).toEqual({ ok: 1 });
    expect(f.refusals).toEqual([]);
  });

  it("an answer marked identity, or not marked, is read as it is", async () => {
    const s = await standIn((req, res) =>
      req.url === "/i" ? (res.writeHead(200, { "Content-Encoding": "identity" }), res.end("plain")) : res.end("bare"));
    const f = made([SITE], s.port);
    expect(await (await f.fetch("http://mcp.example:8080/i")).text()).toBe("plain");
    expect(await (await f.fetch("http://mcp.example:8080/")).text()).toBe("bare");
  });
});
