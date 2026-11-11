import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS } from "../core/datadir.js";
import { visible } from "../core/permissions.js";
import { errorText } from "../core/types.js";
import { API_KEYS } from "../exec/env.js";

// The user's MCP servers, under "mcpServers" in the settings file or in a project's .mcp.json, in Claude Code's shape, so
// an entry copies over unchanged (release 8c design, "The settings entry"). A bad server is left out with a warning and
// the rest apply, as a bad hook is; "mcpServers" itself of the wrong JSON type is a problem, as every entry's is
// (settings.ts), and the file is not applied.

export type ServerEntry =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; timeout?: number }
  | { kind: "http" | "sse"; url: string; headers: Record<string, string>; timeout?: number; oauth?: OAuthEntry };
// scopes: one string, scopes split by spaces, as OAuth's scope parameter is (Claude Code's MCP page; RFC 6749, 3.3).
export interface OAuthEntry { clientId?: string; callbackPort?: number; scopes?: string; authServerMetadataUrl?: string }
export interface ServerConfig {
  name: string; safe: string; // safe: the name with each character but [A-Za-z0-9_-] made "_"
  entry: ServerEntry; where: "user" | "project";
  trusted: "read-only" | null; trustedTools: string[]; // always none for a project's
  alwaysLoad: boolean; // its tools defined in every request, not found through tool_search (release 8c plan, choice 42)
  // The SHA-256 of the entry as written, before ${VAR} is filled, which a project server's answer holds (choice 24): a
  // git pull that changes its command cannot start it unasked, while a variable's new value asks nothing, and no value
  // is kept.
  written: string;
  // The command and arguments, or the address and headers, as written, ${VAR} unfilled, which the project's question
  // shows, so a key filled in from the environment never reaches the screen (release 8c plan, choice 48); of the headers,
  // only the variables they read (choice 64).
  asWritten: { command: string; args: string[] } | { url: string; headers: Record<string, string> };
}

const PROJECT = ".mcp.json";
type File = typeof SETTINGS | typeof PROJECT;

// What a value is, for a line that must not show it: a server, its env, headers, args or address can hold a key, and a
// whole .mcp.json can be any size (Task 2's code review).
const typeOf = (v: unknown) =>
  Array.isArray(v) ? "a list"
  : v === null ? "null"
  : typeof v === "string" ? "text"
  : typeof v === "number" ? "a number"
  : typeof v === "boolean" ? "true or false"
  : "an object";
// As settings.ts's words, whose module imports this one, but naming the value's type, not the value.
const wrongType = (entry: string, what: string, value: unknown) => new Error(`${entry} must be ${what} (got ${typeOf(value)})`);
// A name from the file, quoted and escaped: JSON.stringify leaves direction marks and C1 control codes as they are, and
// a cloned repository's .mcp.json writes these (Task 2's code review).
const quoted = (name: string) => visible(JSON.stringify(name));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

const SERVERS = "an object of servers";
const TEXT = "text in quotes";
const LIST = "a list of text in quotes";
const LOCAL_EXAMPLE = '{"command": "node", "args": ["server.js"]}';
// The plan's words name the user's file this way on every system ("Lines this plan adds").
const USER_FILE = "~/.tachikoma/settings.json";
// Only this machine may be reached without TLS (release 8c design, "The settings entry"); URL gives IPv6 in brackets.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
// A TCP port is a 16-bit number (RFC 9293, 3.1), and 0 asks the system for any free one, which a sign-in's fixed
// callback address cannot be.
const MAX_PORT = 65_535;
// Node's setTimeout waits at most 2,147,483,647 ms, and past that fires after 1 ms (Node's docs for setTimeout), so a
// longer timeout would end every call at once; refused, as a hook's is (hooks/config.ts, MAX_TIMER_MS). Below 1,000 ms
// Claude Code ignores the value and its own MCP_TOOL_TIMEOUT applies (Claude Code's MCP page), so it counts as not set.
const MAX_TIMER_MS = 2_147_483_647;
const MIN_TIMEOUT_MS = 1_000;
const TIMEOUT = `a whole number of milliseconds no more than ${MAX_TIMER_MS.toLocaleString("en-US")}, such as 600000`;

// Each server's own fields, by kind; a field of the other kind is Claude Code's too and does nothing for this server, so
// it is passed over without a line. Any other name is not a server field, and is ignored with one.
const OWN = { stdio: ["command", "args", "env"], remote: ["url", "headers", "oauth", "headersHelper"] };

// Thrown with a left-out line's words after the server's place; "; it was left out" ends each.
class Left extends Error {}

// `file` names the place each line starts with: settings.json: "mcpServers": "<name>", or .mcp.json: "<name>". `env` fills
// ${VAR} (release 8c design, "The settings entry").
export function readServers(file: File, value: unknown, env: NodeJS.ProcessEnv, warnings: string[]): ServerConfig[] {
  if (!isObject(value)) throw wrongType(`${file}: "mcpServers"`, SERVERS, value);
  const where = file === SETTINGS ? "user" : "project";
  const kept: ServerConfig[] = [];
  for (const [name, raw] of Object.entries(value)) {
    const place = file === SETTINGS ? `${SETTINGS}: "mcpServers": ${quoted(name)}` : `${file}: ${quoted(name)}`;
    const say = (words: string) => warnings.push(`${place}${words}`);
    try {
      kept.push(serverOf(name, raw, where, env, say));
    } catch (err) {
      if (!(err instanceof Left)) throw err;
      say(`${err.message}; it was left out`);
    }
  }
  return kept;
}

// The user's entry wins whole, fields never mixed, so a repository cannot replace a server the user trusts with its own
// program under the same name; Claude Code ranks the project's higher (release 8c design, "A project's servers").
export function mergeServers(user: ServerConfig[], project: ServerConfig[]): ServerConfig[] {
  const names = new Set(user.map((s) => s.name));
  return [...user, ...project.filter((s) => !names.has(s.name))];
}

// The project's .mcp.json, at its root, read at the launch only (release 8c plan, Task 2: a known limit). None is no
// servers; one that cannot be read leaves its servers out, with a line, and the user's still apply.
export function readProjectFile(root: string, env: NodeJS.ProcessEnv, warnings: string[]): ServerConfig[] {
  // V8's JSON.parse words quote the file as it is, escape codes and all (Task 2's code review).
  const broken = (reason: string) => {
    warnings.push(`${PROJECT} could not be read (${visible(reason)}); its servers were left out`);
    return [];
  };
  let text: string;
  try {
    text = readFileSync(path.join(root, PROJECT), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return broken(errorText(err));
  }
  // As the settings file (settings.ts, emptyText and entriesOf): an empty file is none, and a byte-order mark at the
  // start, which Windows PowerShell 5.1 writes, is skipped. trim takes the mark as white space too.
  if (!text.trim()) return [];
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return broken(errorText(err));
  }
  if (!isObject(data)) return broken(`it must be one object, such as {"mcpServers": {}} (got ${typeOf(data)})`);
  if (data.mcpServers === undefined) return [];
  if (!isObject(data.mcpServers)) return broken(`"mcpServers" must be ${SERVERS} (got ${typeOf(data.mcpServers)})`);
  return readServers(PROJECT, data.mcpServers, env, warnings);
}

function serverOf(name: string, raw: unknown, where: ServerConfig["where"], env: NodeJS.ProcessEnv, say: (words: string) => void): ServerConfig {
  if (!isObject(raw)) throw new Left(` must be an object, such as ${LOCAL_EXAMPLE} (got ${typeOf(raw)})`);
  // A "__" would make mcp__<server>__<tool> read two ways (release 8c design, finding 2).
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (safe.includes("__")) throw new Left(' has a name that holds "__" once its characters are made safe, which tool names cannot carry');
  const kind = kindOf(raw);
  const remote = kind !== "stdio";
  if (remote && raw.headersHelper !== undefined) throw new Left(' has "headersHelper", which Tachikoma does not run yet (planned)');
  if (!remote && raw.command === undefined) throw new Left(` has no "command"; a local server needs one, such as ${LOCAL_EXAMPLE}`);
  if (remote && raw.url === undefined) throw new Left(' has no "url"; an "http" or "sse" server needs one');

  const own = OWN[remote ? "remote" : "stdio"];
  const other = OWN[remote ? "stdio" : "remote"];
  let trusted: ServerConfig["trusted"] = null;
  let trustedTools: string[] = [];
  let alwaysLoad = false;
  let timeout: number | undefined;
  for (const [field, v] of Object.entries(raw)) {
    if (field === "type" || own.includes(field)) continue; // read below, each by its kind
    else if (field === "trusted" || field === "trustedTools") {
      // Trust is the user's own word that the tools only read, so a project's file cannot give it (release 8c design,
      // "A project's servers").
      if (where === "project") say(` has ${quoted(field)}; trust counts only in ${USER_FILE}, so it was ignored`);
      else if (field === "trusted") {
        if (v !== "read-only") throw badValue(field, '"read-only"', v);
        trusted = v;
      } else {
        if (!texts(v)) throw badValue(field, "a list of tool names in quotes", v);
        trustedTools = v;
      }
    } else if (field === "alwaysLoad") {
      if (typeof v !== "boolean") throw badValue(field, "true or false, without quotes", v);
      alwaysLoad = v;
    } else if (field === "timeout") {
      if (!Number.isInteger(v) || (v as number) > MAX_TIMER_MS) throw badValue(field, TIMEOUT, v);
      if ((v as number) >= MIN_TIMEOUT_MS) timeout = v as number;
    } else if (other.includes(field)) continue;
    else say(` has ${quoted(field)}, which is not a server field; it was ignored`);
  }
  const fill = filler(env);
  let entry: ServerEntry;
  let asWritten: ServerConfig["asWritten"];
  if (kind === "stdio") {
    if (typeof raw.command !== "string") throw bad("command", TEXT, raw.command);
    if (raw.args !== undefined && !texts(raw.args)) throw bad("args", LIST, raw.args);
    const vars = textMap("env", raw.env, '{"KEY": "value"}');
    if (where === "project") noProviderKey([...(raw.args ?? []), ...Object.values(vars)]);
    const args = (raw.args ?? []).map(fill);
    const filledEnv = mapValues(vars, fill);
    if (args.some((a) => a.includes(NUL))) throw bad("args", NO_NUL, "");
    for (const [key, v] of Object.entries(filledEnv)) if (v.includes(NUL)) throw bad(`env.${key}`, NO_NUL, v);
    entry = { kind, command: fill(raw.command), args, env: filledEnv, ...(timeout !== undefined && { timeout }) };
    asWritten = { command: raw.command, args: raw.args ?? [] };
  } else {
    if (typeof raw.url !== "string") throw bad("url", TEXT, raw.url);
    const headers = textMap("headers", raw.headers, '{"Authorization": "Bearer ${TOKEN}"}');
    if (where === "project") noProviderKey([raw.url, ...Object.values(headers)]);
    const oauth = raw.oauth === undefined ? undefined : oauthOf(raw.oauth, say);
    const url = fill(raw.url);
    const filled = mapValues(headers, fill);
    for (const [key, v] of Object.entries(filled)) if (BREAKS.test(v) || v.includes(NUL)) throw bad(`headers.${key}`, NO_BREAKS, v);
    address(raw.url, url);
    entry = { kind, url, headers: filled, ...(timeout !== undefined && { timeout }), ...(oauth && { oauth }) };
    asWritten = { url: raw.url, headers };
  }
  const written = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  return { name, safe, entry, where, trusted, trustedTools, alwaysLoad, written, asWritten };
}

// A field of the wrong type, its value named by its type, as it may hold a key (typeOf); badValue shows the value, for the
// short fields that carry none: type, timeout, alwaysLoad, trusted, trustedTools and oauth.callbackPort. `got` says what
// text of the right type is wrong with, for an address.
const bad = (field: string, what: string, value: unknown, got = typeOf(value)) => new Left(`: ${quoted(field)} must be ${what} (got ${got})`);
const NOT_ADDRESS = "text that is not an address";
// Values Node refuses when the server starts, in an error that quotes them, and one may be a key: a header value with a
// line break or NUL (Headers), an env value or an argument with NUL (spawn). Each is checked once ${VAR} is filled, and
// named by its field only (release 8c plan, Task 2, "Values Node would refuse"; Task 4's review).
const NUL = String.fromCharCode(0);
const BREAKS = /[\r\n]/;
const NO_NUL = "text without NUL characters";
const NO_BREAKS = "text without line breaks";
const badValue = (field: string, what: string, value: unknown) =>
  new Left(`: ${quoted(field)} must be ${what} (got ${visible(JSON.stringify(value))})`);

// Claude Code's types: stdio by default, http also spelled streamable-http, and sse. As in Claude Code, a url with no type
// is a mistake, since no type means a local server.
function kindOf(raw: Record<string, unknown>): ServerEntry["kind"] {
  const type = raw.type;
  if (type === undefined) {
    if (raw.url !== undefined) throw new Left(' has a "url" but no "type", so it would be a local server; add "type": "http" or "sse"');
    return "stdio";
  }
  if (typeof type !== "string") throw badValue("type", '"stdio", "http" or "sse"', type);
  if (type === "stdio" || type === "http" || type === "sse") return type;
  if (type === "streamable-http") return "http";
  if (type === "ws") throw new Left(' has "type" "ws", which Tachikoma does not support');
  throw new Left(` has "type" ${quoted(type)}, which is not "stdio", "http" or "sse"`);
}

// env and headers: text values, each wrong one named on its own, so the line never shows the others, a key among them.
function textMap(field: string, value: unknown, example: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isObject(value)) throw bad(field, `an object of text in quotes, such as ${example}`, value);
  for (const [key, v] of Object.entries(value)) if (typeof v !== "string") throw bad(`${field}.${key}`, TEXT, v);
  return value as Record<string, string>;
}

const mapValues = (map: Record<string, string>, f: (text: string) => string) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, f(v)]));

function oauthOf(value: unknown, say: (words: string) => void): OAuthEntry {
  if (!isObject(value)) throw bad("oauth", 'an object, such as {"clientId": "my-app"}', value);
  const oauth: OAuthEntry = {};
  for (const [name, v] of Object.entries(value)) {
    const field = `oauth.${name}`;
    if (name === "clientId") {
      if (typeof v !== "string") throw bad(field, TEXT, v);
      oauth.clientId = v;
    } else if (name === "authServerMetadataUrl") {
      // "The URL must use https://" (Claude Code's MCP page). ${VAR} is not filled here, so it is checked as written.
      const parsed = typeof v === "string" ? URL.parse(v) : null;
      if (parsed?.protocol !== "https:") {
        const got = typeof v !== "string" ? typeOf(v) : parsed ? "an address that does not start with https://" : NOT_ADDRESS;
        throw bad(field, 'an https:// address, such as "https://auth.example.com/.well-known/openid-configuration"', v, got);
      }
      oauth.authServerMetadataUrl = v as string; // parsed, so text
    } else if (name === "callbackPort") {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_PORT) throw badValue(field, `a port number from 1 to ${MAX_PORT}`, v);
      oauth.callbackPort = v as number;
    } else if (name === "scopes") {
      if (typeof v !== "string") throw bad(field, 'text in quotes, scopes split by spaces, such as "read write"', v);
      oauth.scopes = v;
    } else say(` has ${quoted(field)}, which is not a server field; it was ignored`);
  }
  return oauth;
}

// ${VAR} and ${VAR:-default}, as Claude Code reads them: the name is all before the first ":-", and a variable set to
// empty text is set. Unlike Claude Code, which passes an unset one through as its own text, the server is left out, so a
// key header cannot go out as the text ${SANITY_TOKEN} (release 8c design, "The settings entry"). Only text counts as
// set, so ${constructor} or ${__proto__} cannot fill in what every object has (Task 2's code review); process.env's own
// lookup is kept, which on Windows ignores letter case.
const filler = (env: NodeJS.ProcessEnv) => (text: string) =>
  text.replace(/\$\{([^}]+)\}/g, (_whole, body: string) => {
    const cut = body.indexOf(":-");
    const name = cut < 0 ? body : body.slice(0, cut);
    const value: unknown = env[name];
    if (typeof value === "string") return value;
    if (cut >= 0) return body.slice(cut + 2);
    throw new Left(` needs \${${visible(name)}}, which is not set`);
  });

// The names of the variables `text` reads, as filler reads them: each ${VAR} and ${VAR:-default}, in order.
export const variables = (text: string) => [...text.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.split(":-")[0]!);

// Tachikoma's provider keys never reach a project's server (release 8c plan, choice 64), set or not: a remote one's
// headers or address would carry one off the machine, and a local one's env or arguments hand it over, though commands
// never get them (exec/env.ts). Letter case is ignored, as Windows ignores it in a variable's name.
function noProviderKey(texts: string[]): void {
  for (const name of texts.flatMap(variables)) {
    if (API_KEYS.includes(name.toUpperCase())) throw new Left(` reads \${${visible(name)}}, a provider key, which a project's servers are never given`);
  }
}

// http:// only for this machine, checked after ${VAR} is filled; the line shows the address as written, so it never
// quotes a filled-in value (release 8c design, "The settings entry").
function address(written: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw bad("url", 'an address, such as "https://mcp.example.com/mcp"', written, NOT_ADDRESS);
  }
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOCAL_HOSTS.includes(parsed.hostname))) return;
  throw new Left(` has the address ${visible(written)}, which must start with https:// (http:// is only for localhost, 127.0.0.1 or ::1)`);
}
