// Tachikoma's own requests to a remote MCP server with the allowed sites in force (8c-2b design, section 3; plan,
// Step 8 and decisions 5, 12, 13a and 17, question 8 (a)): a `fetch` of the library's shape on Node's node:http and
// node:tls, which take the checked address directly, so a request goes to the address that was checked. Node's own
// fetch looks the name up again itself. One is made for each owner: one connection of a server, or one sign-in attempt.
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { rules, type Site } from "../sandbox/sites.js";

// A request the allowed sites refuse (W5), or an answer the checked fetch does not read (W14). Not a TypeError, so it
// is never read as a dropped connection and retried (src/mcp/server.ts, isDrop).
export class SiteRefused extends Error {}

export interface SitesFetchOptions {
  sites: Site[];
  own: string[]; // this computer's addresses, read at launch (the design review's finding 4)
  // Hears the first refusal, once (decision 13a), as connectionFetch's `redirected` hears a refused redirect.
  refused?: (err: SiteRefused) => void;
  // Decision 12: tests give the lookup, the plain TCP connect and extra trusted certificates. Nothing else sets them.
  lookup?: (name: string) => Promise<string[]>;
  connect?: (address: string, port: number) => net.Socket;
  ca?: string[];
}

const NO_BODY = new Set([204, 205, 304]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// fetch's own error for a request that could not be made (the Fetch standard's network error), with Node's error as
// its cause, as Node's fetch gives it (src/mcp/server.ts reads both).
const networkError = (cause: unknown) => new TypeError("fetch failed", { cause });

export function sitesFetch(o: SitesFetchOptions): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const lookup =
    o.lookup ?? (async (name: string) => (await dns.promises.lookup(name, { all: true })).map((a) => a.address));
  const connectTo = o.connect ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const ca = o.ca ? [...tls.rootCertificates, ...o.ca] : undefined;
  let first: SiteRefused | undefined;
  // Only the first is kept and told, even when another comes from a request that was already under way (the step's
  // review).
  const refuse = (message: string) => {
    if (!first) {
      first = new SiteRefused(message);
      o.refused?.(first);
    }
    return first;
  };

  return async (input, init = {}) => {
    // Decision 13a: once it has refused, every request is refused at once, with the first reason.
    if (first) throw first;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const url = new URL(input);
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") throw networkError(new Error(`${url.protocol} is not http or https`));
    const port = Number(url.port || (secure ? 443 : 80));
    const name = rules.hostName(url.hostname);
    const shown = `${name?.includes(":") ? `[${name}]` : (name ?? url.hostname)}:${port}`;
    if (name === undefined || !rules.listed(o.sites, url.hostname, port)) {
      throw refuse(`${shown} is not on the allowed sites; add it to "allowedSites" in ~/.tachikoma/settings.json`);
    }
    // Decision 17: the body's kinds the library and Tachikoma send; any other is an error said at once.
    const headers = new Headers(init.headers);
    const body = init.body;
    let bytes: Buffer | undefined;
    if (typeof body === "string") {
      bytes = Buffer.from(body);
      if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8"); // as fetch does
    } else if (body instanceof URLSearchParams) {
      bytes = Buffer.from(body.toString());
      if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (body instanceof ArrayBuffer) bytes = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else if (body !== undefined && body !== null) throw new Error("this request's body is not text, a form or bytes");
    // Decision 5: every address checked, then each tried in order.
    let addresses: string[];
    try {
      addresses = await lookup(name);
    } catch (e) {
      throw networkError(e);
    }
    if (addresses.some((a) => rules.isLocal(a, o.own))) throw refuse(`${shown} points at a local address`);
    if (first) throw first; // a refusal that came while this one looked up
    let socket: net.Socket | undefined;
    let last: unknown = new Error(`getaddrinfo ENOTFOUND ${name}`);
    for (const address of addresses) {
      const s = connectTo(address, port);
      const failed = await new Promise<unknown>((done) => {
        const abort = () => (s.destroy(), done(signal!.reason));
        signal?.addEventListener("abort", abort, { once: true });
        s.once("connect", () => (signal?.removeEventListener("abort", abort), done(undefined)));
        s.once("error", (e) => (signal?.removeEventListener("abort", abort), done(e)));
      });
      if (signal?.aborted) {
        s.destroy(); // one that connected as the abort came (the step's review)
        throw signal.reason;
      }
      if (failed === undefined) {
        socket = s;
        break;
      }
      last = failed;
    }
    if (!socket) throw networkError(last);
    // The name is kept for TLS and the Host header; the certificate is checked for it, as Node's fetch does.
    const wire: net.Socket = secure ? tls.connect({ socket, servername: name, ...(ca && { ca }) }) : socket;
    headers.set("host", port === (secure ? 443 : 80) ? name : `${name}:${port}`);
    // Decision 17, the second review's finding 4: an uncompressed answer only.
    headers.set("accept-encoding", "identity");
    if (bytes) headers.set("content-length", String(bytes.length));
    const method = (init.method ?? "GET").toUpperCase();
    return await new Promise<Response>((resolve, reject) => {
      const req = http.request({
        method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers),
        setHost: false,
        createConnection: () => wire,
      });
      const stop = () => req.destroy(signal!.reason);
      signal?.addEventListener("abort", stop, { once: true });
      req.on("error", (e) => {
        signal?.removeEventListener("abort", stop);
        reject(signal?.aborted ? signal.reason : networkError(e));
      });
      req.on("response", (res) => {
        const encoding = res.headers["content-encoding"];
        if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
          signal?.removeEventListener("abort", stop);
          res.destroy();
          wire.destroy();
          const why = `the server sent a compressed answer (${encoding}), which Tachikoma does not read with the`;
          return reject(refuse(`${why} allowed sites in force`));
        }
        const status = res.statusCode ?? 502;
        // A status a Response cannot hold is a failed request, as with Node's fetch (the step's review).
        if (status < 200 || status > 599) {
          signal?.removeEventListener("abort", stop);
          res.destroy();
          wire.destroy();
          return reject(networkError(new Error(`the server answered with status ${status}`)));
        }
        if (init.redirect === "error" && REDIRECTS.has(status)) {
          signal?.removeEventListener("abort", stop);
          res.destroy();
          return reject(networkError(new Error("the server answered with a redirect")));
        }
        const back = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) back.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const empty = method === "HEAD" || NO_BODY.has(status);
        if (empty) res.resume();
        // After the headers an abort ends the body and the connection with the signal's reason.
        signal?.removeEventListener("abort", stop);
        const cut = () => (res.destroy(signal!.reason), wire.destroy());
        signal?.addEventListener("abort", cut, { once: true });
        res.on("close", () => signal?.removeEventListener("abort", cut));
        // A body cut part way is a TypeError, as Node's fetch gives it, so it reads as a dropped connection
        // (src/mcp/server.ts, isDrop); an abort keeps the signal's reason (the step's review).
        const inner = empty ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>).getReader();
        const stream = inner
          ? new ReadableStream<Uint8Array>({
              async pull(c) {
                try {
                  const r = await inner.read();
                  if (r.done) c.close();
                  else c.enqueue(r.value);
                } catch (e) {
                  c.error(signal?.aborted ? signal.reason : networkError(e));
                }
              },
              cancel: (why) => inner.cancel(why),
            })
          : null;
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? "", headers: back }));
      });
      req.end(bytes);
    });
  };
}
