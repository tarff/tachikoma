import { visible } from "../core/permissions.js";
import { runHook } from "../hooks/run.js";

// A remote entry's headersHelper (8c-2a design, "headersHelper"): a command that prints the server's headers as a JSON
// object of text values. It is stopped after 10 seconds, Claude Code's documented limit (design, "How").
export const HELPER_MS = 10_000;

// A variable a project's helper never gets, by its name (8c-2a plan, decision 13), as Claude Code does.
const CREDENTIAL = /TOKEN|SECRET|PASSWORD|KEY|AUTH/i;

// An HTTP header name: a token (RFC 9110, section 5.6.2; decision 15).
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// A name from the helper's output, quoted as config.ts quotes one, its control characters shown as escapes.
const quoted = (name: string) => visible(JSON.stringify(name));

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const textMap = (value: unknown): value is Record<string, string> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");

export interface HelperOptions {
  name: string;
  url: string;
  cwd: string;
  root: string;
  env: NodeJS.ProcessEnv;
  project: boolean;
  signal?: AbortSignal;
  limitMs?: number;
}

// Runs the helper as a hook runs (hooks/run.ts), in `cwd`, with stdin closed at once, CLAUDE_PROJECT_DIR set to `root`
// and the server's name and address in CLAUDE_CODE_MCP_SERVER_NAME and _URL, so a helper written for Claude Code works
// unchanged; a project's gets no variable whose name looks like a credential. It gives the headers, or why they could
// not be had, choice 5's `<why>`, from the exit code or the start's error code alone, never what the helper printed, as
// a helper prints secrets (decision 28). A stop kills it and rejects with Cancelled, as runHook does.
export async function runHelper(
  command: string,
  opts: HelperOptions,
): Promise<{ headers: Record<string, string> } | { reason: string }> {
  const seconds = (opts.limitMs ?? HELPER_MS) / 1000;
  const { cwd, root, signal } = opts;
  const given = Object.entries(opts.env);
  const kept = opts.project ? Object.fromEntries(given.filter(([n]) => !CREDENTIAL.test(n))) : opts.env;
  const env = { ...kept, CLAUDE_CODE_MCP_SERVER_NAME: opts.name, CLAUDE_CODE_MCP_SERVER_URL: opts.url };
  const ran = await runHook({ command }, undefined, { cwd, projectDir: root, env, limit: seconds, signal });
  if (ran.failed === "start") return { reason: `it could not start (${ran.startCode})` };
  if (ran.failed === "time") return { reason: `it did not finish within ${seconds} s` };
  if (ran.signal) return { reason: `it was ended by signal ${ran.signal}` };
  if (ran.code !== 0) return { reason: `it exited with code ${ran.code}` };
  const headers = parsed(ran.stdout);
  if (!textMap(headers)) return { reason: "it printed something other than a JSON object of text values" };
  for (const [name, value] of Object.entries(headers)) {
    if (!TOKEN.test(name)) return { reason: `it gave ${quoted(name)}, which is not a header name` };
    if (/[\r\n\0]/.test(value)) {
      return { reason: `it gave the header ${quoted(name)} a value with a line break or NUL` };
    }
  }
  return { headers };
}

// The helper's headers over the static ones of the same name, whatever the letter case (Claude Code: "Dynamic headers
// override any static headers with the same name").
export function mergeHeaders(fixed: Record<string, string>, given: Record<string, string>): Record<string, string> {
  const names = new Set(Object.keys(given).map((name) => name.toLowerCase()));
  return { ...Object.fromEntries(Object.entries(fixed).filter(([name]) => !names.has(name.toLowerCase()))), ...given };
}
