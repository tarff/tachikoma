import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commandEnv, system32 } from "../../src/exec/env.js";
import { launchAnswers } from "../../src/mcp/answers.js";
import { listen } from "../../src/auth/oauth.js";
import { AuthStore, McpAuth } from "../../src/mcp/auth.js";
import type { OAuthEntry, ServerConfig } from "../../src/mcp/config.js";
import { Servers } from "../../src/mcp/servers.js";
import { Bus, removeTree } from "../helpers.js";
import { signInFake } from "./fake.js";

// Release 8c plan, Task 11: signing in to a remote server, against the fake sign-in service of fake.ts on 127.0.0.1, the
// browser a function of the test's own.

const windows = process.platform === "win32";
// A wait on a request to the fake: a few seconds for a busy machine, well inside the test's 15 s.
const WAIT = { timeout: 5_000 };

const remote = (name: string, url: string, oauth?: OAuthEntry, headers: Record<string, string> = {}): ServerConfig => ({
  name, safe: name, where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
  entry: { kind: "http", url, headers, ...(oauth && { oauth }) }, asWritten: { url, headers },
});

// The test's own folder, the data folder two levels inside it, the fake, and Servers that use that data folder's
// sign-ins, each stopped before the folder is removed. `opened` holds each address the browser was given, `damaged` each
// damaged file's line. `fakeOpts` are the fake's.
async function setup(fakeOpts: Parameters<typeof signInFake>[0] = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-auth-"));
  const made: Servers[] = [];
  onTestFinished(async () => {
    await Promise.all(made.map((s) => s.stopAll()));
    await removeTree(dir);
  });
  const data = path.join(dir, "data", "tachi");
  const fake = await signInFake(fakeOpts);
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const opened: string[] = [];
  const damaged: string[] = [];
  let browser: (url: string) => void = fake.browser;
  const make = (configs: ServerConfig[], opts: { headless?: boolean } = {}) => {
    const servers = new Servers(configs, {
      root: dir, env: process.env, bus, answers: launchAnswers, network: "none", lead: () => "fake:a",
      auth: new AuthStore(data, () => {}, (line) => damaged.push(line)), openBrowser: (url) => (opened.push(url), browser(url)), ...opts,
    });
    made.push(servers);
    servers.startAll();
    return servers;
  };
  const states = (servers: Servers) => servers.list().map((s) => `${s.name} ${s.state.is}`);
  const asked: string[] = [];
  const said: string[] = [];
  const io = (yes = true, signal = new AbortController().signal) => ({
    ask: async (q: string) => (asked.push(q), yes),
    say: (l: string) => said.push(l),
    signal,
  });
  return { dir, data, fake, notes, opened, damaged, make, states, asked, said, io, setBrowser: (b: (url: string) => void) => (browser = b) };
}

// Every SID in a file's permissions, read as tests/auth/private.test.ts reads them; nothing is changed.
function sids(file: string): string[] {
  const script = "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:P).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...commandEnv(), P: file } })
    .trim()
    .split(/\r?\n/);
}
// A port the system says is free now: one it gives for port 0, let go again.
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const me = () => execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",")[1]!.replaceAll('"', "");

describe("signing in to a remote MCP server", () => {
  // The design, "Remote servers and sign-in": the launch never waits, nor registers or opens anything; Sign in asks, opens
  // the browser at Tachikoma's own address, says where it waits, takes the code and connects again on the tokens.
  it("needs sign-in at the start, then signs in through the browser and connects on its tokens, kept private", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(t.fake.seen.registered).toBe(0);
    expect(t.opened).toEqual([]);
    expect(t.notes).toEqual([]); // the window says nothing: /mcp shows it

    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.asked).toEqual([`Open your browser to sign in to om at ${new URL(t.fake.base).host}`]);
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]).toMatch(/^http:\/\/localhost:\d+\/start$/); // Claude Code's form (choice 53)
    expect(t.said).toEqual([`Waiting for the sign-in in your browser. If it did not open, go to: ${t.opened[0]}`]);
    expect(t.states(servers)).toEqual(["om ready"]);
    expect(servers.signedIn("om")).toBe(true);
    // One registration, for the address the sign-in waited at, and one code exchanged.
    expect(t.fake.seen.registered).toBe(1);
    expect(t.fake.seen.grants).toEqual(["authorization_code"]);
    expect(t.fake.seen.authorized[0]!.get("redirect_uri")).toBe(t.opened[0]!.replace("/start", "/callback"));

    const file = path.join(t.data, "mcp-auth.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.servers).toHaveLength(1);
    expect(saved.servers[0]).toMatchObject({ name: "om", url: t.fake.url, client: { client_id: "client-1" }, tokens: { token_type: "Bearer" } });
    if (windows) expect(sids(file)).toEqual([me()]);
    else expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("uses the saved tokens at the next launch, asking nothing", async () => {
    const t = await setup();
    await t.make([remote("om", t.fake.url)]).ready();
    await t.make([remote("om", t.fake.url)]).signIn("om", t.io());
    const grants = t.fake.seen.grants.length;
    const next = t.make([remote("om", t.fake.url)]);
    await next.ready();
    expect(t.states(next)).toEqual(["om ready"]);
    expect(t.fake.seen.grants).toHaveLength(grants);
    expect(t.fake.seen.bearer.at(-1)).toMatch(/^Bearer access-\d+$/);
    expect(t.asked).toHaveLength(1);
  });

  // The library refreshes on a 401, and saveTokens keeps what it got.
  it("refreshes a stale token at the next start, and keeps the new one", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    await servers.signIn("om", t.io());
    const store = new AuthStore(t.data);
    const before = store.get("om", t.fake.url)!.tokens!.access_token;
    t.fake.expire();
    const next = t.make([remote("om", t.fake.url)]);
    await next.ready();
    expect(t.states(next)).toEqual(["om ready"]);
    expect(t.fake.seen.grants).toEqual(["authorization_code", "refresh_token"]);
    const after = store.get("om", t.fake.url)!.tokens!.access_token;
    expect(after).not.toBe(before);
    expect(t.fake.seen.bearer.at(-1)).toBe(`Bearer ${after}`);
  });

  it("forgets the tokens and the client on sign out, so the server needs sign-in again", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    await servers.signIn("om", t.io());
    await servers.signOut("om");
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(servers.signedIn("om")).toBe(false);
    expect(new AuthStore(t.data).get("om", t.fake.url)).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(t.data, "mcp-auth.json"), "utf8"))).toEqual({ servers: [] });
  });

  // Choice 28: kept by name and address, so a server's entry moved to another address is never sent the old tokens.
  it("never sends a server's tokens to a new address under the same name", async () => {
    const t = await setup();
    const first = t.make([remote("om", t.fake.url)]);
    await first.ready();
    await first.signIn("om", t.io());
    const elsewhere = `${t.fake.base}/other/mcp`;
    const seen = t.fake.seen.bearer.length;
    const moved = t.make([remote("om", elsewhere)]);
    await moved.ready();
    expect(t.states(moved)).toEqual(["om needs sign-in"]);
    expect(t.fake.seen.bearer.slice(seen)).toEqual([null]);
    expect(moved.signedIn("om")).toBe(false);
  });

  it("opens nothing on a no, and stops waiting for the browser on Esc", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(await servers.signIn("om", t.io(false))).toBe(false);
    expect(t.opened).toEqual([]);
    expect(t.said).toEqual([]);
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    // The client registered before the question is not a sign-in, so there is nothing to sign out of (choice 58).
    expect(t.fake.seen.registered).toBe(1);
    expect(servers.signedIn("om")).toBe(false);
    // A browser that never comes back; Esc once the waiting line is said.
    t.setBrowser(() => {});
    const esc = new AbortController();
    const signing = servers.signIn("om", { ...t.io(true, esc.signal), say: () => esc.abort() });
    await expect(signing).rejects.toThrow();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    // Its address no longer waits.
    await expect(fetch(t.opened.at(-1)!)).rejects.toThrow();
  });

  // The service's own words when it refuses, as the browser brings them back.
  it("fails with the sign-in service's words when it refuses", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    t.setBrowser(t.fake.sendsBack({ error: "access_denied", error_description: "The user said no" }));
    await expect(servers.signIn("om", t.io())).rejects.toThrow("The user said no");
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
  });

  // The entry's oauth fields (Claude Code's): a clientId registers nothing, and callbackPort is where Tachikoma waits.
  it("signs in with the entry's clientId and waits at its callbackPort", async () => {
    const t = await setup();
    const port = await freePort();
    const servers = t.make([remote("om", t.fake.url, { clientId: "given-id", callbackPort: port })]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.fake.seen.registered).toBe(0);
    expect(t.fake.seen.authorized[0]!.get("client_id")).toBe("given-id");
    expect(t.opened[0]).toBe(`http://localhost:${port}/start`);
    expect(t.states(servers)).toEqual(["om ready"]);
  });

  // -p cannot sign in: its note, and nothing registered or opened.
  it("says in -p that a server needs sign-in, opening nothing", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)], { headless: true });
    await servers.ready();
    expect(t.notes).toEqual(["MCP server om needs sign-in, which -p cannot do; sign in from /mcp in the window."]);
    expect(t.opened).toEqual([]);
    expect(t.fake.seen.registered).toBe(0);
  });

  // A file that is not what this code writes holds no sign-in, is never quoted, and is replaced at the next sign-in.
  it("counts a damaged file as holding no sign-in, and replaces it at the next one", async () => {
    const t = await setup();
    const store = new AuthStore(t.data);
    const file = path.join(t.data, "mcp-auth.json");
    await store.change("x", "https://x.example/mcp", () => ({})); // makes the private folder
    writeFileSync(file, "{ not json");
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    const inHome = path.relative(homedir(), file);
    const named = inHome.startsWith("..") || path.isAbsolute(inHome) ? file : path.join("~", inHome);
    expect(t.damaged).toEqual([`MCP sign-ins in ${named} could not be read, so they were left out; signing in again replaces them.`]);
    await servers.signIn("om", t.io());
    await vi.waitFor(() => expect(t.states(servers)).toEqual(["om ready"]), WAIT);
    expect(t.damaged).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8")).servers.map((r: { name: string }) => r.name)).toEqual(["om"]);
  });

  // Choice 55: an entry with its own Authorization header, in any letter case, is never signed in: its 401 points at its
  // key, and nothing goes to a sign-in service.
  it("keeps a 401 to an entry with its own Authorization header as a failure, in any letter case", async () => {
    for (const name of ["Authorization", "authorization"]) {
      const t = await setup();
      const servers = t.make([remote("om", t.fake.url, undefined, { [name]: "Bearer the-key" })]);
      await servers.ready();
      expect(servers.list()[0]!.state).toEqual({ is: "failed", reason: `${t.fake.base} answered 401` });
      expect(t.fake.seen.requests.length).toBeGreaterThan(0);
      expect(t.fake.seen.requests.filter((r) => r.path !== "/mcp")).toEqual([]);
      expect(t.fake.seen.registered).toBe(0);
    }
  });

  // Choices 54 and 55: an entry with other headers signs in, as the Figma plugin's does; its headers go only to requests for
  // the server's own address, never to the sign-in service, here at the same host.
  it("signs in an entry with other headers, which go only to the server's own address", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url, undefined, { "X-Region": "eu" })]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.states(servers)).toEqual(["om ready"]);
    const toServer = t.fake.seen.requests.filter((r) => r.path === "/mcp");
    const signIn = t.fake.seen.requests.filter((r) => r.path !== "/mcp");
    expect(signIn.map((r) => r.path)).toEqual(expect.arrayContaining(["/.well-known/oauth-authorization-server", "/register", "/authorize", "/token"]));
    expect(signIn.filter((r) => "x-region" in r.headers)).toEqual([]);
    expect(toServer.length).toBeGreaterThan(0);
    expect(toServer.every((r) => r.headers["x-region"] === "eu")).toBe(true);
    // The server's own calls carry the sign-in's token beside it.
    expect(toServer.at(-1)!.headers.authorization).toMatch(/^Bearer access-\d+$/);
  });

  // Choice 59: a server that answers 401 but publishes no sign-in details cannot be signed in to.
  it("keeps a 401 from a server with no sign-in details as a failure", async () => {
    const t = await setup({ metadata: "none" });
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(servers.list()[0]!.state).toEqual({ is: "failed", reason: `${t.fake.base} answered 401` });
    expect(t.fake.seen.registered).toBe(0);
  });

  // Choice 58: the entry's authServerMetadataUrl gives the sign-in service's metadata where discovery finds none.
  it("signs in through the entry's authServerMetadataUrl", async () => {
    const t = await setup({ metadata: "elsewhere" });
    const plain = t.make([remote("plain", t.fake.url)]);
    await plain.ready();
    expect(plain.list()[0]!.state).toEqual({ is: "failed", reason: `${t.fake.base} answered 401` });
    const servers = t.make([remote("om", t.fake.url, { authServerMetadataUrl: `${t.fake.base}/elsewhere/metadata` })]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.states(servers)).toEqual(["om ready"]);
  });

  // One that cannot be reached is a server with no sign-in details, not the server's own failure (Task 11's re-check).
  it("takes an authServerMetadataUrl that cannot be reached as no sign-in details", async () => {
    const t = await setup({ metadata: "elsewhere" });
    const gone = http.createServer();
    await new Promise<void>((done) => gone.listen(0, "127.0.0.1", done));
    const port = (gone.address() as AddressInfo).port;
    await new Promise<void>((done) => gone.close(() => done())); // nothing listens there now
    const servers = t.make([remote("om", t.fake.url, { authServerMetadataUrl: `http://127.0.0.1:${port}/metadata` })]);
    await servers.ready();
    expect(servers.list()[0]!.state).toEqual({ is: "failed", reason: `${t.fake.base} answered 401` });
  });

  // Choice 70 (the outside review of PR #17, finding 2): a server that names its discovery document only in its 401 is
  // signed in to through it, as the launch found it.
  it("signs in through the discovery document the server's 401 named", async () => {
    const t = await setup({ metadata: "challenge" });
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.states(servers)).toEqual(["om ready"]);
    expect(t.fake.seen.grants).toEqual(["authorization_code"]);
  });

  // Choice 70 (finding 3): Esc while the token request is out saves nothing when its tokens come after, so the server
  // still needs sign-in, at the next start too.
  it("saves no tokens that come after Esc", async () => {
    const t = await setup({ slow: true });
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    const saving = vi.spyOn(McpAuth.prototype, "saveTokens");
    onTestFinished(() => saving.mockRestore());
    const esc = new AbortController();
    const signing = servers.signIn("om", t.io(true, esc.signal));
    await vi.waitFor(() => expect(t.fake.seen.grants).toEqual(["authorization_code"]), WAIT);
    esc.abort();
    await expect(signing).rejects.toBe(esc.signal.reason);
    t.fake.answer();
    await vi.waitFor(() => expect(saving).toHaveBeenCalled(), WAIT);
    await saving.mock.results[0]!.value;
    expect(new AuthStore(t.data).get("om", t.fake.url)?.tokens).toBeUndefined();
    expect(servers.signedIn("om")).toBe(false);
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    const next = t.make([remote("om", t.fake.url)]);
    await next.ready();
    expect(t.states(next)).toEqual(["om needs sign-in"]);
  });

  // Choice 59: a sign-in lost mid-session, here a stale token with no refresh token to renew it.
  it("needs sign-in again when the sign-in is lost mid-session, and the call says so to the model", async () => {
    const t = await setup({ refresh: false });
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    await servers.signIn("om", t.io());
    expect(t.states(servers)).toEqual(["om ready"]);
    t.fake.expire();
    const call = servers.server("om")!.callTool("echo", {}, {});
    await expect(call).rejects.toThrow(new Error("The MCP server om needs sign-in, which the user does from /mcp."));
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
  });

  // Choice 59: the entry's clientId wins over a client kept under another id, such as a mistyped one since fixed.
  it("signs in with the entry's clientId over a client kept under another id", async () => {
    const t = await setup();
    await new AuthStore(t.data).change("om", t.fake.url, () => ({ client: { client_id: "mistyped-id", issuer: t.fake.base } }));
    const servers = t.make([remote("om", t.fake.url, { clientId: "given-id" })]);
    await servers.ready();
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.fake.seen.authorized.map((q) => q.get("client_id"))).toEqual(["given-id"]);
    expect(t.fake.seen.registered).toBe(0);
  });

  // Choice 59: nothing is registered at the launch, even when a kept client's sign-in service is not the one found now.
  it("registers nothing at the launch when a kept client's sign-in service has changed", async () => {
    const t = await setup();
    await new AuthStore(t.data).change("om", t.fake.url, () => ({ client: { client_id: "old-id", issuer: "https://elsewhere.example" } }));
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(t.fake.seen.registered).toBe(0);
  });

  // Choice 59's reasons, in "Sign-in to <name> failed: <reason>".
  it("says why a sign-in failed: no code, the entry's callbackPort in use, no client id to sign in with", async () => {
    const t = await setup();
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    t.setBrowser(t.fake.sendsBack({}));
    await expect(servers.signIn("om", t.io())).rejects.toThrow(new Error("the sign-in page sent back no code"));
    const port = await freePort();
    const held = http.createServer();
    await new Promise<void>((resolve) => held.listen(port, "127.0.0.1", resolve));
    onTestFinished(() => void held.close());
    const busy = t.make([remote("busy", t.fake.url, { callbackPort: port })]);
    await busy.ready();
    await expect(busy.signIn("busy", t.io())).rejects.toThrow(new Error(`port ${port}, the entry's callbackPort, is in use`));
    const u = await setup({ registration: false });
    const none = u.make([remote("om", u.fake.url)]);
    await none.ready();
    expect(u.states(none)).toEqual(["om needs sign-in"]);
    const needsId = 'the sign-in service needs a client id; set "oauth": {"clientId": ...} in the server\'s entry';
    await expect(none.signIn("om", u.io())).rejects.toThrow(new Error(needsId));
  });

  // Choice 60: a service that registers only apps it approved (Figma's answers 403) says what to do, before asking anything.
  it("says a refused registration needs a client id from the service", async () => {
    const t = await setup({ registration: "refused" });
    const servers = t.make([remote("om", t.fake.url)]);
    await servers.ready();
    const refused = 'the sign-in service refused to register Tachikoma (403), as it takes only apps it approved; a client id it gives you goes in "oauth": {"clientId": ...} in the server\'s entry';
    await expect(servers.signIn("om", t.io())).rejects.toThrow(new Error(refused));
    const asked = t.fake.seen.requests.filter((r) => r.path === "/register");
    expect(asked).toHaveLength(1);
    expect(t.asked).toEqual([]);
    expect(t.opened).toEqual([]);
  });

  // A refresh the service refuses: the tokens go, and the library's warning never reaches the screen (Task 11's review).
  it("drops a refused refresh's tokens and needs sign-in, writing none of the library's warnings", async () => {
    const t = await setup();
    const first = t.make([remote("om", t.fake.url)]);
    await first.ready();
    await first.signIn("om", t.io());
    t.fake.expire();
    t.fake.revoke();
    // A console.warn of its own in place, as the window's Ink puts one in place as it starts.
    const before = console.warn;
    const warned: unknown[][] = [];
    console.warn = (...args: unknown[]) => void warned.push(args);
    onTestFinished(() => void (console.warn = before));
    const next = t.make([remote("om", t.fake.url)]);
    await next.ready();
    expect(t.states(next)).toEqual(["om needs sign-in"]);
    expect(t.fake.seen.grants).toContain("refresh_token");
    expect(new AuthStore(t.data).get("om", t.fake.url)?.tokens).toBeUndefined();
    expect(warned).toEqual([]);
    console.warn("other words");
    expect(warned).toEqual([["other words"]]); // anything else still gets there
  });

  // A refused refresh token drops only itself: tokens another window refreshed meanwhile stay (Task 11's review).
  it("keeps the tokens another window refreshed meanwhile when a refresh token is refused", async () => {
    const t = await setup();
    const store = new AuthStore(t.data);
    const tokens = (n: number) => ({ access_token: `a${n}`, refresh_token: `r${n}`, token_type: "Bearer" });
    await store.change("om", t.fake.url, () => ({ tokens: tokens(1) }));
    const client = new McpAuth(store, remote("om", t.fake.url));
    const step = { issuer: t.fake.url }; // the library's sign-in steps pass this; a plain request's read does not
    client.tokens(step);
    await store.change("om", t.fake.url, () => ({ tokens: tokens(2) }));
    client.tokens(); // a request reading r2 meanwhile leaves the guard on r1 (Task 11's re-check)
    await client.invalidateCredentials("tokens");
    expect(store.get("om", t.fake.url)?.tokens?.refresh_token).toBe("r2");
    client.tokens(step);
    await client.invalidateCredentials("tokens");
    expect(store.get("om", t.fake.url)?.tokens).toBeUndefined();
  });
});

// Choice 53: the sign-in's own address, Claude Code's form, on both of this machine's own addresses at one port; and
// /login chatgpt's, as it was.
describe("the sign-in's own address", () => {
  // Whether this machine has ::1 to listen on.
  const ipv6 = () =>
    new Promise<boolean>((resolve) => {
      const s = http.createServer();
      s.once("error", () => resolve(false)).listen(0, "::1", () => s.close(() => resolve(true)));
    });
  const answered = async (local: { port: number; hosts?: string[] }, at: string) => {
    const l = await listen("s", undefined, local);
    onTestFinished(l.close);
    const port = new URL(l.redirectUri).port;
    expect([l.redirectUri, l.startUri]).toEqual([`http://localhost:${port}/callback`, `http://localhost:${port}/start`]);
    await fetch(`http://${at}:${port}/callback?state=s&code=c`).then((r) => r.text());
    return (await l.reply).get("code");
  };

  it("answers at localhost on 127.0.0.1 and ::1, and on 127.0.0.1 alone where the machine has no other", async () => {
    expect(await answered({ port: 0 }, "127.0.0.1")).toBe("c");
    if (await ipv6()) expect(await answered({ port: 0 }, "[::1]")).toBe("c");
    // 192.0.2.1 (TEST-NET-1, RFC 5737) is no address of this machine's: it stands for a missing ::1.
    expect(await answered({ port: 0, hosts: ["127.0.0.1", "192.0.2.1"] }, "127.0.0.1")).toBe("c");
  });

  it("keeps /login chatgpt's address", async () => {
    const l = await listen("s");
    onTestFinished(l.close);
    expect(l.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(l.startUri).toBe(l.redirectUri.replace("/callback", "/start"));
  });
});
