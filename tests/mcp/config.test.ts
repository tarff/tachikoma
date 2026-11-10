import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { mergeServers, readProjectFile, readServers, type ServerConfig } from "../../src/mcp/config.js";
import { removeTree } from "../helpers.js";

// The environment ${VAR} is filled from: never the user's own, so no test depends on what this machine has set.
const ENV = { TOKEN: "sk-secret-123", HOST: "example.com", EMPTY: "" };
const read = (servers: unknown, env: NodeJS.ProcessEnv = ENV) => {
  const warnings: string[] = [];
  const kept = readServers("settings.json", { s: servers }, env, warnings);
  return { kept, warnings };
};
// The one server's warnings, from an entry named "s".
const said = (server: unknown, env?: NodeJS.ProcessEnv) => read(server, env).warnings;
const left = (words: string) => [`settings.json: "mcpServers": "s"${words}`];
const local = (more: Record<string, unknown> = {}) => ({ command: "node", args: ["server.js"], ...more });
const remote = (more: Record<string, unknown> = {}) => ({ type: "http", url: "https://mcp.example.com/mcp", ...more });
const TIMEOUT = "a whole number of milliseconds no more than 2,147,483,647, such as 600000";
// ServerConfig.written: the entry as written, before ${VAR} is filled (release 8c plan, choice 24).
const writtenOf = (raw: unknown) => createHash("sha256").update(JSON.stringify(raw)).digest("hex");

describe("readServers", () => {
  // Release 8c design, "The settings entry": Claude Code's shape, each server with its defaults.
  it("reads a local and a remote server in Claude Code's shape", () => {
    const warnings: string[] = [];
    const kept = readServers("settings.json", { tradingview: local(), sanity: remote() }, ENV, warnings);
    expect(warnings).toEqual([]);
    expect(kept).toEqual<ServerConfig[]>([
      {
        name: "tradingview", safe: "tradingview", where: "user", trusted: null, trustedTools: [], alwaysLoad: false,
        entry: { kind: "stdio", command: "node", args: ["server.js"], env: {} }, written: writtenOf(local()),
        asWritten: { command: "node", args: ["server.js"] },
      },
      {
        name: "sanity", safe: "sanity", where: "user", trusted: null, trustedTools: [], alwaysLoad: false,
        entry: { kind: "http", url: "https://mcp.example.com/mcp", headers: {} }, written: writtenOf(remote()),
        asWritten: { url: "https://mcp.example.com/mcp" },
      },
    ]);
  });

  it("reads every field Claude Code's entry and Tachikoma's trust take", () => {
    const oauth = { clientId: "my-app", callbackPort: 8080, scopes: "channels:read chat:write", authServerMetadataUrl: "https://auth.example.com/meta" };
    const raw = { ...remote({ type: "sse", headers: { "X-Team": "a" }, timeout: 120000, oauth }), alwaysLoad: true, trusted: "read-only" };
    const { kept, warnings } = read(raw);
    expect(warnings).toEqual([]);
    expect(kept).toEqual<ServerConfig[]>([{
      name: "s", safe: "s", where: "user", trusted: "read-only", trustedTools: [], alwaysLoad: true,
      entry: { kind: "sse", url: "https://mcp.example.com/mcp", headers: { "X-Team": "a" }, timeout: 120000, oauth }, written: writtenOf(raw),
      asWritten: { url: "https://mcp.example.com/mcp" },
    }]);
    const tools = read(local({ type: "stdio", env: { A: "1" }, timeout: 5000, trustedTools: ["quote_get", "chart_get_state"], alwaysLoad: false }));
    expect(tools.warnings).toEqual([]);
    expect(tools.kept[0]).toMatchObject({ trusted: null, trustedTools: ["quote_get", "chart_get_state"], alwaysLoad: false });
    expect(tools.kept[0]!.entry).toEqual({ kind: "stdio", command: "node", args: ["server.js"], env: { A: "1" }, timeout: 5000 });
  });

  it('reads "streamable-http" as "http"', () => {
    expect(read(remote({ type: "streamable-http" })).kept[0]!.entry).toEqual({ kind: "http", url: "https://mcp.example.com/mcp", headers: {} });
  });

  // The plan's "Lines this plan adds", "The settings entry": each line, triggered, and the server left out.
  it("leaves out a server of a kind Tachikoma does not run, with its line", () => {
    expect(read(remote({ type: "ws" }))).toEqual({ kept: [], warnings: left(' has "type" "ws", which Tachikoma does not support; it was left out') });
    expect(said(remote({ type: "grpc" }))).toEqual(left(' has "type" "grpc", which is not "stdio", "http" or "sse"; it was left out'));
    expect(said(remote({ headersHelper: "get-token.sh" }))).toEqual(left(' has "headersHelper", which Tachikoma does not run yet (planned); it was left out'));
  });

  it("leaves out a server missing what its kind needs", () => {
    // As in Claude Code: no "type" is a local server, so a url alone is a mistake.
    expect(read({ url: "https://mcp.example.com/mcp" })).toEqual({
      kept: [],
      warnings: left(' has a "url" but no "type", so it would be a local server; add "type": "http" or "sse"; it was left out'),
    });
    const noCommand = ' has no "command"; a local server needs one, such as {"command": "node", "args": ["server.js"]}; it was left out';
    expect(said({ args: ["x"] })).toEqual(left(noCommand));
    expect(said({ type: "stdio", url: "https://mcp.example.com/mcp" })).toEqual(left(noCommand));
    expect(said({ type: "http" })).toEqual(left(' has no "url"; an "http" or "sse" server needs one; it was left out'));
    expect(said({ type: "sse", command: "node" })).toEqual(left(' has no "url"; an "http" or "sse" server needs one; it was left out'));
  });

  it("leaves out a server with a field of the wrong type, saying what it must be", () => {
    const cases: [unknown, string][] = [
      [local({ type: 3 }), ': "type" must be "stdio", "http" or "sse" (got 3); it was left out'],
      [local({ command: ["node"] }), ': "command" must be text in quotes (got a list); it was left out'],
      [local({ args: "server.js" }), ': "args" must be a list of text in quotes (got text); it was left out'],
      [local({ args: [1] }), ': "args" must be a list of text in quotes (got a list); it was left out'],
      [local({ env: ["A=1"] }), ': "env" must be an object of text in quotes, such as {"KEY": "value"} (got a list); it was left out'],
      [local({ env: { A: 1 } }), ': "env.A" must be text in quotes (got a number); it was left out'],
      [local({ env: { A: true } }), ': "env.A" must be text in quotes (got true or false); it was left out'],
      [local({ env: { A: null } }), ': "env.A" must be text in quotes (got null); it was left out'],
      [local({ env: { A: {} } }), ': "env.A" must be text in quotes (got an object); it was left out'],
      [local({ timeout: 1.5 }), `: "timeout" must be ${TIMEOUT} (got 1.5); it was left out`],
      [local({ timeout: 2147483648 }), `: "timeout" must be ${TIMEOUT} (got 2147483648); it was left out`],
      [local({ timeout: "5000" }), `: "timeout" must be ${TIMEOUT} (got "5000"); it was left out`],
      [local({ alwaysLoad: "true" }), ': "alwaysLoad" must be true or false, without quotes (got "true"); it was left out'],
      [local({ trusted: true }), ': "trusted" must be "read-only" (got true); it was left out'],
      [local({ trustedTools: "quote_get" }), ': "trustedTools" must be a list of tool names in quotes (got "quote_get"); it was left out'],
      [remote({ url: 3 }), ': "url" must be text in quotes (got a number); it was left out'],
      [
        remote({ url: "not an address" }),
        ': "url" must be an address, such as "https://mcp.example.com/mcp" (got text that is not an address); it was left out',
      ],
      [
        remote({ headers: "Bearer x" }),
        ': "headers" must be an object of text in quotes, such as {"Authorization": "Bearer ${TOKEN}"} (got text); it was left out',
      ],
      [remote({ headers: { "X-N": 2 } }), ': "headers.X-N" must be text in quotes (got a number); it was left out'],
      [remote({ oauth: "my-app" }), ': "oauth" must be an object, such as {"clientId": "my-app"} (got text); it was left out'],
      [remote({ oauth: { clientId: 1 } }), ': "oauth.clientId" must be text in quotes (got a number); it was left out'],
      [remote({ oauth: { callbackPort: 0 } }), ': "oauth.callbackPort" must be a port number from 1 to 65535 (got 0); it was left out'],
      [remote({ oauth: { callbackPort: 65536 } }), ': "oauth.callbackPort" must be a port number from 1 to 65535 (got 65536); it was left out'],
      [
        remote({ oauth: { scopes: ["read", "write"] } }),
        ': "oauth.scopes" must be text in quotes, scopes split by spaces, such as "read write" (got a list); it was left out',
      ],
      ...([
        [5, "a number"],
        ["auth.example.com/meta", "text that is not an address"],
        ["http://auth.example.com/meta", "an address that does not start with https://"],
      ] as const).map(([v, got]): [unknown, string] => [
        remote({ oauth: { authServerMetadataUrl: v } }),
        ': "oauth.authServerMetadataUrl" must be an https:// address, such as "https://auth.example.com/.well-known/openid-configuration" ' +
          `(got ${got}); it was left out`,
      ]),
    ];
    for (const [server, words] of cases) expect(read(server)).toEqual({ kept: [], warnings: left(words) });
  });

  // Claude Code's MCP page: below 1,000 ms the value is ignored, so it is not set; Node's longest timer is the most.
  it("takes a timeout from 1,000 to 2,147,483,647 ms, and one below 1,000 as not set", () => {
    const timeout = (ms: number) => read(local({ timeout: ms }));
    const unset = { kind: "stdio", command: "node", args: ["server.js"], env: {} };
    for (const ms of [999, 0, -5]) expect(timeout(ms)).toEqual({ kept: [expect.objectContaining({ entry: unset })], warnings: [] });
    expect(timeout(1000).kept[0]!.entry).toMatchObject({ timeout: 1000 });
    expect(timeout(2147483647).kept[0]!.entry).toMatchObject({ timeout: 2147483647 });
    expect(read(remote({ timeout: 999 })).kept[0]!.entry).toEqual({ kind: "http", url: "https://mcp.example.com/mcp", headers: {} });
  });

  // Not one of the plan's lines: a server that is not an object at all (the builder's words, for the controller to check).
  it("leaves out a server that is not an object", () => {
    expect(read("node server.js")).toEqual({
      kept: [],
      warnings: left(' must be an object, such as {"command": "node", "args": ["server.js"]} (got text); it was left out'),
    });
  });

  // Task 2's code review: a wrong type is named by its type, as a server, its env, headers, args, command, address or
  // oauth fields can hold a key.
  it("never shows a key in a wrong-type line", () => {
    const KEY = "sk-live-123";
    const cases: unknown[] = [
      `--api-key ${KEY}`,
      local({ env: [`API_KEY=${KEY}`] }),
      local({ env: { API_KEY: [KEY] } }),
      local({ args: `--api-key ${KEY}` }),
      local({ command: [KEY] }),
      remote({ headers: `Authorization: Bearer ${KEY}` }),
      remote({ headers: { Authorization: [`Bearer ${KEY}`] } }),
      remote({ url: [`https://x/?key=${KEY}`] }),
      remote({ url: `${KEY} not an address` }),
      remote({ oauth: `clientId ${KEY}` }),
      remote({ oauth: { clientId: [KEY] } }),
      remote({ oauth: { scopes: [KEY] } }),
      remote({ oauth: { authServerMetadataUrl: `http://auth.example.com/?k=${KEY}` } }),
    ];
    for (const server of cases) {
      const words = said(server);
      expect(words).toHaveLength(1);
      const got = /\(got (a list|text|a number|true or false|null|an object|text that is not an address|an address that does not start with https:\/\/)\)/;
      expect(words[0]).toMatch(new RegExp(`${got.source}; it was left out$`));
      expect(words[0]).not.toContain("sk-");
    }
    const value = [{ command: "node", env: { API_KEY: KEY } }];
    expect(() => readServers("settings.json", value, ENV, [])).toThrow(new Error('settings.json: "mcpServers" must be an object of servers (got a list)'));
  });

  // Task 2's code review: names and fields from a cloned repository's .mcp.json cannot carry escape codes, direction
  // marks or C1 control codes onto the screen.
  it("shows a server's name and a field's name with their control and direction characters escaped", () => {
    const warnings: string[] = [];
    readServers(".mcp.json", { "a\u202eb": { type: "ws" }, c: local({ "x\u0085\u2066": 1 }) }, ENV, warnings);
    expect(warnings).toEqual([
      '.mcp.json: "a\\u202eb" has "type" "ws", which Tachikoma does not support; it was left out',
      '.mcp.json: "c" has "x\\u0085\\u2066", which is not a server field; it was ignored',
    ]);
    const other: string[] = [];
    readServers("settings.json", { s: remote({ type: "w\u202es", oauth: { "y\u2069": 1 } }), t: remote({ headers: { "h\u009b": 1 } }) }, ENV, other);
    expect(other).toEqual([
      'settings.json: "mcpServers": "s" has "type" "w\\u202es", which is not "stdio", "http" or "sse"; it was left out',
      'settings.json: "mcpServers": "t": "headers.h\\u009b" must be text in quotes (got a number); it was left out',
    ]);
  });

  // Task 2's code review: only a variable's text counts, so what every object has is not a variable.
  it("takes ${constructor}, ${toString} and ${__proto__} as not set", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(said(local({ command: `\${${name}}` }))).toEqual(left(` needs \${${name}}, which is not set; it was left out`));
    }
    expect(read(local({ command: "${constructor:-node}" })).kept[0]!.entry).toMatchObject({ command: "node" });
  });

  // process.env on Windows finds a variable whatever its letter case; the lookup keeps that.
  it.runIf(process.platform === "win32")("finds a variable in process.env whatever its letter case, on Windows", () => {
    const { kept } = read(local({ command: "${systemroot}" }), process.env);
    expect(kept[0]!.entry).toMatchObject({ command: process.env.SystemRoot });
  });

  it("ignores a field that is not a server field, with its line, and keeps the server", () => {
    const { kept, warnings } = read(remote({ comment: "mine", oauth: { clientId: "a", extra: 1 } }));
    expect(kept).toHaveLength(1);
    expect(warnings).toEqual([
      'settings.json: "mcpServers": "s" has "comment", which is not a server field; it was ignored',
      'settings.json: "mcpServers": "s" has "oauth.extra", which is not a server field; it was ignored',
    ]);
  });

  // A field of the other kind is Claude Code's own and does nothing for this server (the builder's choice, reported).
  it("ignores, without a line, a field that belongs to the other kind of server", () => {
    expect(read(local({ type: "stdio", headers: { A: "b" }, oauth: {}, url: "x" }))).toEqual({ kept: [expect.objectContaining({ name: "s" })], warnings: [] });
    expect(read(remote({ command: "node", args: ["x"], env: { A: "1" } })).warnings).toEqual([]);
  });

  // Release 8c design, "The settings entry": ${VAR} and ${VAR:-default}, as Claude Code fills them.
  it("fills ${VAR} and ${VAR:-default} in command, args, env, url and headers", () => {
    const env = { BIN: "C:/tools/node.exe", DIR: "C:/srv", KEY: "k1", TOKEN: "t1", TEAM: "core", EMPTY: "" };
    const args = ["${DIR}/server.js", "--port=${PORT:-3000}", "${EMPTY:-unused}"];
    const l = read(local({ command: "${BIN}", args, env: { API_KEY: "${KEY}", MODE: "${MODE:-dev}" } }), env);
    expect(l.warnings).toEqual([]);
    // A variable set to empty text is set, and used as it is (Claude Code's way).
    expect(l.kept[0]!.entry).toEqual({
      kind: "stdio", command: "C:/tools/node.exe", args: ["C:/srv/server.js", "--port=3000", ""], env: { API_KEY: "k1", MODE: "dev" },
    });
    const r = read(remote({ url: "https://${HOST:-mcp.example.com}/${TEAM}", headers: { Authorization: "Bearer ${TOKEN}", "X-Default": "${NONE:-x}" } }), env);
    expect(r.warnings).toEqual([]);
    expect(r.kept[0]!.entry).toEqual({ kind: "http", url: "https://mcp.example.com/core", headers: { Authorization: "Bearer t1", "X-Default": "x" } });
    expect(read(local({ command: "${NODE:-node}" }), env).kept[0]!.entry).toMatchObject({ command: "node" });
  });

  // Release 8c plan, choice 24: a project server's answer holds `written`, so a pulled change to its command is asked
  // about again, while a variable's new value is not.
  it("gives the same written for a new ${VAR} value, and another for a changed command, in either file", () => {
    for (const file of ["settings.json", ".mcp.json"] as const) {
      const of = (raw: unknown, env: NodeJS.ProcessEnv) => readServers(file, { s: raw }, env, [])[0]!.written;
      const raw = local({ args: ["${DIR}/server.js"] });
      expect(of(raw, { DIR: "a" })).toBe(writtenOf(raw));
      expect(of(raw, { DIR: "b" })).toBe(of(raw, { DIR: "a" }));
      expect(of(local({ command: "other", args: ["${DIR}/server.js"] }), { DIR: "a" })).not.toBe(of(raw, { DIR: "a" }));
    }
  });

  // Release 8c plan, choice 48: the project's question shows the entry as written, so a key filled in never reaches it.
  it("keeps the command, arguments and address as written, ${VAR} unfilled, beside the filled entry", () => {
    const [stdio] = read(local({ command: "${HOST}-node", args: ["--key=${TOKEN}"] })).kept;
    expect(stdio!.entry).toMatchObject({ command: "example.com-node", args: ["--key=sk-secret-123"] });
    expect(stdio!.asWritten).toEqual({ command: "${HOST}-node", args: ["--key=${TOKEN}"] });
    const [http] = read(remote({ url: "https://mcp.example.com/mcp?key=${TOKEN}" })).kept;
    expect(http!.entry).toMatchObject({ url: "https://mcp.example.com/mcp?key=sk-secret-123" });
    expect(http!.asWritten).toEqual({ url: "https://mcp.example.com/mcp?key=${TOKEN}" });
  });

  it("leaves out a server needing a variable that is not set, naming it, in each field", () => {
    const line = left(" needs ${MISSING}, which is not set; it was left out");
    expect(said(local({ command: "${MISSING}" }))).toEqual(line);
    expect(said(local({ args: ["--key=${MISSING}"] }))).toEqual(line);
    expect(said(local({ env: { K: "${MISSING}" } }))).toEqual(line);
    expect(said(remote({ url: "https://${MISSING}/mcp" }))).toEqual(line);
    expect(said(remote({ headers: { Authorization: "Bearer ${MISSING}" } }))).toEqual(line);
  });

  // The design: a warning never quotes a filled-in value, so a key cannot reach the screen or a log.
  it("never puts a key header's filled-in value in a warning", () => {
    const words = [
      ...said(remote({ url: "http://${HOST}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } })),
      ...said(remote({ headers: { Authorization: "Bearer ${TOKEN}", "X-Other": "${MISSING}" } })),
      ...said(remote({ headers: { Authorization: "Bearer ${TOKEN}" }, note: "x" })),
      ...said(remote({ headers: { Authorization: "Bearer ${TOKEN}" }, type: "ws" })),
    ];
    expect(words).toHaveLength(4);
    for (const w of words) expect(w).not.toContain(ENV.TOKEN);
  });

  // Release 8c plan, Task 2, "Values Node would refuse": Node's own error would quote the value, which can be a key, so the
  // server is left out with a line naming only the field, checked after ${VAR} is filled (Task 4's review).
  it("leaves out a header with a line break or NUL, and an env value or argument with NUL, never showing the value", () => {
    const NUL = String.fromCharCode(0);
    const env = { ...ENV, BROKEN: "sk-secret-456\nx", NULLED: `sk-secret-789${NUL}x` };
    const header = left(': "headers.Authorization" must be text without line breaks (got text); it was left out');
    const cases: [unknown, string[]][] = [
      [remote({ headers: { Authorization: "Bearer sk-secret-1\rx" } }), header],
      [remote({ headers: { Authorization: "Bearer sk-secret-2\nx" } }), header],
      [remote({ headers: { Authorization: `Bearer sk-secret-3${NUL}` } }), header],
      [remote({ headers: { Authorization: "Bearer ${BROKEN}" } }), header],
      [local({ env: { K: `sk-secret-4${NUL}` } }), left(': "env.K" must be text without NUL characters (got text); it was left out')],
      [local({ env: { K: "${NULLED}" } }), left(': "env.K" must be text without NUL characters (got text); it was left out')],
      [local({ args: ["--key=${NULLED}"] }), left(': "args" must be text without NUL characters (got text); it was left out')],
    ];
    for (const [server, line] of cases) {
      const { kept, warnings } = read(server, env);
      expect(kept).toEqual([]);
      expect(warnings).toEqual(line);
      expect(warnings.join("")).not.toContain("sk-secret");
    }
    // A line break is fine in an env value or an argument, which Node passes on.
    expect(read(local({ env: { K: "${BROKEN}" }, args: ["${BROKEN}"] }), env).kept).toHaveLength(1);
    const warnings: string[] = [];
    readServers(".mcp.json", { s: local({ args: ["${NULLED}"] }) }, env, warnings);
    expect(warnings).toEqual(['.mcp.json: "s": "args" must be text without NUL characters (got text); it was left out']);
  });

  // Release 8c design, "The settings entry": http:// only for this machine, checked after ${VAR} is filled.
  it("takes http:// only for localhost, 127.0.0.1 or ::1", () => {
    for (const url of ["http://127.0.0.1:3000", "http://localhost:8080/mcp", "http://[::1]:9000", "HTTP://LOCALHOST/mcp", "https://example.com"]) {
      expect(said(remote({ url }))).toEqual([]);
    }
    const address = (url: string) =>
      left(` has the address ${url}, which must start with https:// (http:// is only for localhost, 127.0.0.1 or ::1); it was left out`);
    expect(read(remote({ url: "http://example.com" }))).toEqual({ kept: [], warnings: address("http://example.com") });
    expect(said(remote({ url: "ftp://localhost/mcp" }))).toEqual(address("ftp://localhost/mcp"));
    expect(said(remote({ url: "http://127.0.0.1.example.com/" }))).toEqual(address("http://127.0.0.1.example.com/"));
    // Filled first, and said as written, so the line names what is in the file.
    expect(said(remote({ url: "http://${HOST}/mcp" }))).toEqual(address("http://${HOST}/mcp"));
    expect(said(remote({ url: "http://${LOCAL:-localhost}/mcp" }))).toEqual([]);
  });

  // Release 8c design, finding 2: a "__" in the safe name would make mcp__<server>__<tool> read two ways.
  it('keeps a.b beside a_b, and leaves out a name that holds "__" once made safe', () => {
    const warnings: string[] = [];
    const kept = readServers("settings.json", { "a.b": local(), a_b: local(), a__b: local(), "a..b": local(), "my server!": local() }, ENV, warnings);
    expect(kept.map((s) => [s.name, s.safe])).toEqual([["a.b", "a_b"], ["a_b", "a_b"], ["my server!", "my_server_"]]);
    const line = (name: string) =>
      `settings.json: "mcpServers": ${JSON.stringify(name)} has a name that holds "__" once its characters are made safe, ` +
      "which tool names cannot carry; it was left out";
    expect(warnings).toEqual([line("a__b"), line("a..b")]);
  });

  it("names the server in its lines with its quotes and escapes", () => {
    const warnings: string[] = [];
    readServers("settings.json", { 'a"b\n': { type: "ws" } }, ENV, warnings);
    expect(warnings).toEqual(['settings.json: "mcpServers": "a\\"b\\n" has "type" "ws", which Tachikoma does not support; it was left out']);
  });

  // The plan's line for mcpServers of the wrong type: a problem, so the file is not applied (settings.ts).
  it("refuses mcpServers that is not an object of servers", () => {
    for (const [value, got] of [[[], "a list"], ["x", "text"], [null, "null"], [3, "a number"], [true, "true or false"]]) {
      const words = `settings.json: "mcpServers" must be an object of servers (got ${got})`;
      expect(() => readServers("settings.json", value, ENV, [])).toThrow(new Error(words));
    }
  });

  // Release 8c design, "A project's servers": trust marks in .mcp.json never count.
  it("drops trust from .mcp.json with its lines, and keeps the server", () => {
    const warnings: string[] = [];
    const raw = local({ trusted: "read-only", trustedTools: ["x"], other: 1 });
    const kept = readServers(".mcp.json", { s: raw }, ENV, warnings);
    expect(kept).toEqual<ServerConfig[]>([{
      name: "s", safe: "s", where: "project", trusted: null, trustedTools: [], alwaysLoad: false,
      entry: { kind: "stdio", command: "node", args: ["server.js"], env: {} }, written: writtenOf(raw),
      asWritten: { command: "node", args: ["server.js"] },
    }]);
    expect(warnings).toEqual([
      '.mcp.json: "s" has "trusted"; trust counts only in ~/.tachikoma/settings.json, so it was ignored',
      '.mcp.json: "s" has "trustedTools"; trust counts only in ~/.tachikoma/settings.json, so it was ignored',
      '.mcp.json: "s" has "other", which is not a server field; it was ignored',
    ]);
    // Even of a type the user's file would refuse: it is dropped before it is read.
    const bad: string[] = [];
    expect(readServers(".mcp.json", { s: local({ trusted: true }) }, ENV, bad)).toHaveLength(1);
    expect(bad).toEqual(['.mcp.json: "s" has "trusted"; trust counts only in ~/.tachikoma/settings.json, so it was ignored']);
  });

  it("starts a project's left-out lines with .mcp.json", () => {
    const warnings: string[] = [];
    readServers(".mcp.json", { s: { type: "ws" } }, ENV, warnings);
    expect(warnings).toEqual(['.mcp.json: "s" has "type" "ws", which Tachikoma does not support; it was left out']);
  });
});

describe("mergeServers", () => {
  // Release 8c design, "A project's servers": the user's entry wins whole, so a repository cannot replace a server the
  // user trusts with its own program under the same name.
  it("keeps the user's server over a project's of the same name, fields never mixed", () => {
    const user = readServers("settings.json", { sanity: remote({ trusted: "read-only" }) }, ENV, []);
    const project = readServers(".mcp.json", { sanity: local({ command: "evil" }), extra: local() }, ENV, []);
    expect(mergeServers(user, project)).toEqual([user[0], project[1]]);
    expect(mergeServers(user, project)[0]).toEqual({
      name: "sanity", safe: "sanity", where: "user", trusted: "read-only", trustedTools: [], alwaysLoad: false,
      entry: { kind: "http", url: "https://mcp.example.com/mcp", headers: {} }, written: writtenOf(remote({ trusted: "read-only" })),
      asWritten: { url: "https://mcp.example.com/mcp" },
    });
    expect(mergeServers([], project)).toEqual(project);
  });
});

describe("readProjectFile", () => {
  const project = async (text?: string) => {
    const root = await mkdtemp(path.join(tmpdir(), "tachi-mcp-config-"));
    onTestFinished(() => removeTree(root));
    if (text !== undefined) await writeFile(path.join(root, ".mcp.json"), text);
    return root;
  };
  const readIn = (root: string) => {
    const warnings: string[] = [];
    return { kept: readProjectFile(root, ENV, warnings), warnings };
  };

  it("reads the servers in the project's .mcp.json, as the project's", async () => {
    const root = await project(JSON.stringify({ mcpServers: { tools: local({ args: ["${HOST}.js"] }) } }));
    expect(readIn(root)).toEqual({
      kept: [{
        name: "tools", safe: "tools", where: "project", trusted: null, trustedTools: [], alwaysLoad: false,
        entry: { kind: "stdio", command: "node", args: ["example.com.js"], env: {} }, written: writtenOf(local({ args: ["${HOST}.js"] })),
        asWritten: { command: "node", args: ["${HOST}.js"] },
      }],
      warnings: [],
    });
  });

  it("gives none, and no line, without a .mcp.json, or with one holding no servers", async () => {
    expect(readIn(await project())).toEqual({ kept: [], warnings: [] });
    expect(readIn(await project("{}"))).toEqual({ kept: [], warnings: [] });
    expect(readIn(await project("  \r\n"))).toEqual({ kept: [], warnings: [] });
  });

  // Written by Windows PowerShell 5.1's Out-File, as settings.ts skips it too.
  it("skips a byte-order mark at the start", async () => {
    expect(readIn(await project(`\u{FEFF}${JSON.stringify({ mcpServers: { s: local() } })}`)).kept).toHaveLength(1);
  });

  it("says when .mcp.json cannot be read, and leaves its servers out", async () => {
    let parser = "";
    try {
      JSON.parse("{");
    } catch (err) {
      parser = (err as Error).message;
    }
    const line = (reason: string) => [`.mcp.json could not be read (${reason}); its servers were left out`];
    expect(readIn(await project("{"))).toEqual({ kept: [], warnings: line(parser) });
    expect(readIn(await project('["sk-live-123"]')).warnings).toEqual(line('it must be one object, such as {"mcpServers": {}} (got a list)'));
    expect(readIn(await project('{"mcpServers": ["sk-live-123"]}')).warnings).toEqual(line('"mcpServers" must be an object of servers (got a list)'));
    expect(readIn(await project('"sk-live-123"')).warnings).toEqual(line('it must be one object, such as {"mcpServers": {}} (got text)'));
  });

  // Task 2's code review: V8's JSON.parse words quote the file as it is, so a cloned repository's file could put escape
  // codes on the screen.
  it("shows no escape code from a .mcp.json that is not JSON", async () => {
    const { warnings } = readIn(await project("\u001b]0;x\u0007"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\.mcp\.json could not be read \(.*\); its servers were left out$/);
    expect(warnings[0]).not.toMatch(/[\u001b\u0007]/);
    expect(warnings[0]).toContain("\\u001b");
  });

  it("says when .mcp.json is a folder", async () => {
    const root = await project();
    await mkdir(path.join(root, ".mcp.json"));
    const { kept, warnings } = readIn(root);
    expect(kept).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\.mcp\.json could not be read \(EISDIR.*\); its servers were left out$/);
  });
});
