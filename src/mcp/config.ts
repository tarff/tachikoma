import { readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS } from "../core/datadir.js";
import { visible } from "../core/permissions.js";
import { errorText } from "../core/types.js";

// The user's MCP servers, under "mcpServers" in the settings file or in a project's .mcp.json, in Claude Code's shape, so
// an entry copies over unchanged (release 8c design, "The settings entry"). A bad server is left out with a warning and
// the rest apply, as a bad hook is; "mcpServers" itself of the wrong JSON type is a problem, as every entry's is
// (settings.ts), and the file is not applied.

export type ServerEntry =
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; timeout?: number }
  | { kind: "http" | "sse"; url: string; headers: Record<string, string>; timeout?: number; oauth?: OAuthEntry };
export interface OAuthEntry { clientId?: string; callbackPort?: number; scopes?: string[]; authServerMetadataUrl?: string }
export interface ServerConfig {
  name: string; safe: string; // safe: the name with each character but [A-Za-z0-9_-] made "_"
  entry: ServerEntry; where: "user" | "project";
  trusted: "read-only" | null; trustedTools: string[]; // always none for a project's
  alwaysLoad: boolean; // its tools defined in every request, not found through tool_search (release 8c plan, choice 42)
}

const PROJECT = ".mcp.json";
type File = typeof SETTINGS | typeof PROJECT;

// As settings.ts's, whose words every entry's problems use; that module imports this one.
const wrongType = (entry: string, what: string, value: unknown) => new Error(`${entry} must be ${what} (got ${JSON.stringify(value)})`);
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
    const place = file === SETTINGS ? `${SETTINGS}: "mcpServers": ${JSON.stringify(name)}` : `${file}: ${JSON.stringify(name)}`;
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
  const broken = (reason: string) => {
    warnings.push(`${PROJECT} could not be read (${reason}); its servers were left out`);
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
  if (!isObject(data)) return broken(`it must be one object, such as {"mcpServers": {}} (got ${JSON.stringify(data)})`);
  if (data.mcpServers === undefined) return [];
  if (!isObject(data.mcpServers)) return broken(`"mcpServers" must be ${SERVERS} (got ${JSON.stringify(data.mcpServers)})`);
  return readServers(PROJECT, data.mcpServers, env, warnings);
}

function serverOf(name: string, raw: unknown, where: ServerConfig["where"], env: NodeJS.ProcessEnv, say: (words: string) => void): ServerConfig {
  if (!isObject(raw)) throw new Left(` must be an object, such as ${LOCAL_EXAMPLE} (got ${JSON.stringify(raw)})`);
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
      if (where === "project") say(` has ${JSON.stringify(field)}; trust counts only in ${USER_FILE}, so it was ignored`);
      else if (field === "trusted") {
        if (v !== "read-only") throw bad(field, '"read-only"', v);
        trusted = v;
      } else {
        if (!texts(v)) throw bad(field, "a list of tool names in quotes", v);
        trustedTools = v;
      }
    } else if (field === "alwaysLoad") {
      if (typeof v !== "boolean") throw bad(field, "true or false, without quotes", v);
      alwaysLoad = v;
    } else if (field === "timeout") {
      if (!Number.isInteger(v) || (v as number) < 1) throw bad(field, "a whole number of milliseconds from 1", v);
      timeout = v as number;
    } else if (other.includes(field)) continue;
    else say(` has ${JSON.stringify(field)}, which is not a server field; it was ignored`);
  }
  const fill = filler(env);
  const time = timeout !== undefined && { timeout };
  let entry: ServerEntry;
  if (kind === "stdio") {
    if (typeof raw.command !== "string") throw bad("command", TEXT, raw.command);
    if (raw.args !== undefined && !texts(raw.args)) throw bad("args", LIST, raw.args);
    const vars = textMap("env", raw.env, '{"KEY": "value"}');
    entry = { kind, command: fill(raw.command), args: (raw.args ?? []).map(fill), env: mapValues(vars, fill), ...time };
  } else {
    if (typeof raw.url !== "string") throw bad("url", TEXT, raw.url);
    const headers = textMap("headers", raw.headers, '{"Authorization": "Bearer ${TOKEN}"}');
    const oauth = raw.oauth === undefined ? undefined : oauthOf(raw.oauth, say);
    const url = fill(raw.url);
    const filled = mapValues(headers, fill);
    address(raw.url, url);
    entry = { kind, url, headers: filled, ...time, ...(oauth && { oauth }) };
  }
  return { name, safe, entry, where, trusted, trustedTools, alwaysLoad };
}

const bad = (field: string, what: string, value: unknown) => new Left(`: ${JSON.stringify(field)} must be ${what} (got ${JSON.stringify(value)})`);

// Claude Code's types: stdio by default, http also spelled streamable-http, and sse. As in Claude Code, a url with no type
// is a mistake, since no type means a local server.
function kindOf(raw: Record<string, unknown>): ServerEntry["kind"] {
  const type = raw.type;
  if (type === undefined) {
    if (raw.url !== undefined) throw new Left(' has a "url" but no "type", so it would be a local server; add "type": "http" or "sse"');
    return "stdio";
  }
  if (typeof type !== "string") throw bad("type", '"stdio", "http" or "sse"', type);
  if (type === "stdio" || type === "http" || type === "sse") return type;
  if (type === "streamable-http") return "http";
  if (type === "ws") throw new Left(' has "type" "ws", which Tachikoma does not support');
  throw new Left(` has "type" ${JSON.stringify(type)}, which is not "stdio", "http" or "sse"`);
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
    if (name === "clientId" || name === "authServerMetadataUrl") {
      if (typeof v !== "string") throw bad(field, TEXT, v);
      oauth[name] = v;
    } else if (name === "callbackPort") {
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_PORT) throw bad(field, `a port number from 1 to ${MAX_PORT}`, v);
      oauth.callbackPort = v as number;
    } else if (name === "scopes") {
      if (!texts(v)) throw bad(field, LIST, v);
      oauth.scopes = v;
    } else say(` has ${JSON.stringify(field)}, which is not a server field; it was ignored`);
  }
  return oauth;
}

// ${VAR} and ${VAR:-default}, as Claude Code reads them: the name is all before the first ":-", and a variable set to
// empty text is set. Unlike Claude Code, which passes an unset one through as its own text, the server is left out, so a
// key header cannot go out as the text ${SANITY_TOKEN} (release 8c design, "The settings entry").
const filler = (env: NodeJS.ProcessEnv) => (text: string) =>
  text.replace(/\$\{([^}]+)\}/g, (_whole, body: string) => {
    const cut = body.indexOf(":-");
    const name = cut < 0 ? body : body.slice(0, cut);
    const value = env[name];
    if (value !== undefined) return value;
    if (cut >= 0) return body.slice(cut + 2);
    throw new Left(` needs \${${visible(name)}}, which is not set`);
  });

// http:// only for this machine, checked after ${VAR} is filled; the line shows the address as written, so it never
// quotes a filled-in value (release 8c design, "The settings entry").
function address(written: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw bad("url", 'an address, such as "https://mcp.example.com/mcp"', written);
  }
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && LOCAL_HOSTS.includes(parsed.hostname))) return;
  throw new Left(` has the address ${visible(written)}, which must start with https:// (http:// is only for localhost, 127.0.0.1 or ::1)`);
}
