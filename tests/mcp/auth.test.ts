import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commandEnv, system32 } from "../../src/exec/env.js";
import { launchAnswers } from "../../src/mcp/answers.js";
import { AuthStore } from "../../src/mcp/auth.js";
import type { OAuthEntry, ServerConfig } from "../../src/mcp/config.js";
import { Servers } from "../../src/mcp/servers.js";
import { Bus, removeTree } from "../helpers.js";
import { signInFake } from "./fake.js";

// Release 8c plan, Task 11: signing in to a remote server, against the fake sign-in service of fake.ts on 127.0.0.1, the
// browser a function of the test's own.

const windows = process.platform === "win32";
// A wait on a request to the fake: a few seconds for a busy machine, well inside the test's 15 s.
const WAIT = { timeout: 5_000 };

const remote = (name: string, url: string, oauth?: OAuthEntry): ServerConfig => ({
  name, safe: name, where: "user", trusted: null, trustedTools: [], alwaysLoad: false, written: "",
  entry: { kind: "http", url, headers: {}, ...(oauth && { oauth }) }, asWritten: { url },
});

// The test's own folder, the data folder two levels inside it, the fake, and Servers that use that data folder's
// sign-ins, each stopped before the folder is removed. `opened` holds each address the browser was given.
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "tachi-mcp-auth-"));
  const made: Servers[] = [];
  onTestFinished(async () => {
    await Promise.all(made.map((s) => s.stopAll()));
    await removeTree(dir);
  });
  const data = path.join(dir, "data", "tachi");
  const fake = await signInFake();
  const bus = new Bus();
  const notes: string[] = [];
  bus.on("mcp-note", (line) => notes.push(line));
  const opened: string[] = [];
  let browser: (url: string) => void = fake.browser;
  const make = (configs: ServerConfig[], opts: { headless?: boolean } = {}) => {
    const servers = new Servers(configs, {
      root: dir, env: process.env, bus, answers: launchAnswers, network: "none", lead: () => "fake:a",
      auth: new AuthStore(data), openBrowser: (url) => (opened.push(url), browser(url)), ...opts,
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
  return { dir, data, fake, notes, opened, make, states, asked, said, io, setBrowser: (b: (url: string) => void) => (browser = b) };
}

// Every SID in a file's permissions, read as tests/auth/private.test.ts reads them; nothing is changed.
function sids(file: string): string[] {
  const script = "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:P).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...commandEnv(), P: file } })
    .trim()
    .split(/\r?\n/);
}
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
    expect(t.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/start$/);
    expect(t.said).toEqual([`Waiting for the sign-in in your browser. If it did not open, go to: ${t.opened[0]}`]);
    expect(t.states(servers)).toEqual(["om ready"]);
    expect(servers.signedIn("om")).toBe(true);
    // One registration, for the address the sign-in waited at, and one code exchanged.
    expect(t.fake.seen.registered).toBe(1);
    expect(t.fake.seen.grants).toEqual(["authorization_code"]);
    expect(t.fake.seen.authorized[0]!.get("redirect_uri")).toBe(t.opened[0]!.replace("/auth/start", "/auth/callback"));

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
    t.setBrowser(t.fake.refusing("The user said no"));
    await expect(servers.signIn("om", t.io())).rejects.toThrow("The user said no");
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
  });

  // The entry's oauth fields (Claude Code's): a clientId registers nothing, and callbackPort is where Tachikoma waits.
  it("signs in with the entry's clientId and waits at its callbackPort", async () => {
    const t = await setup();
    // A port the system says is free now: one it gives for port 0, let go again.
    const port = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const servers = t.make([remote("om", t.fake.url, { clientId: "given-id", callbackPort: port })]);
    await servers.ready();
    expect(t.states(servers)).toEqual(["om needs sign-in"]);
    expect(await servers.signIn("om", t.io())).toBe(true);
    expect(t.fake.seen.registered).toBe(0);
    expect(t.fake.seen.authorized[0]!.get("client_id")).toBe("given-id");
    expect(t.opened[0]).toBe(`http://127.0.0.1:${port}/auth/start`);
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
    await servers.signIn("om", t.io());
    await vi.waitFor(() => expect(t.states(servers)).toEqual(["om ready"]), WAIT);
    expect(JSON.parse(readFileSync(file, "utf8")).servers.map((r: { name: string }) => r.name)).toEqual(["om"]);
  });
});
