#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { render } from "ink";
import { accountCommand } from "./auth/chatgpt.js";
import { endOnEpipe, headlessAnswer, headlessExit, jsonLine, prose, statusSegments } from "./clilib.js";
import { Bus } from "./core/bus.js";
import { attachErrorLog } from "./core/errorlog.js";
import { MODES, type Mode, PermissionGate } from "./core/permissions.js";
import { systemPrompt } from "./core/prompt.js";
import { Session } from "./core/session.js";
import { Stats } from "./core/stats.js";
import { errorText, type Provider } from "./core/types.js";
import { LocalExecutor } from "./exec/local.js";
import { EFFORTS, type Effort } from "./providers/anthropic.js";
import { createProvider } from "./providers/registry.js";
import { TOOLS } from "./tools/index.js";
import { App } from "./tui/App.js";
import { SEGMENTS } from "./tui/StatusLine.js";

const HELP = `tachi: a coding agent for your terminal

Usage:
  tachi --lead <provider:model> [options]            interactive session
  tachi --lead <provider:model> -p "<prompt>"        run one prompt, print the answer, exit
  tachi login chatgpt [--new | --account <number>]   sign in to use your ChatGPT plan
  tachi logout chatgpt                               sign out of ChatGPT

Options:
  --lead <spec>     anthropic:<model> | chatgpt:<model> | openai:<model> | openrouter:<model>
                    | kimi:<model> | ollama:<model> (or set TACHI_LEAD)
                    chatgpt: uses your ChatGPT plan; openai: uses OPENAI_API_KEY
  --mode <mode>     when to ask before acting: ${MODES.join(" | ")} (default: ask)
  --effort <level>  Anthropic models only: ${EFFORTS.join(" | ")}
  --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
  --status <list>   status line parts, comma-separated: ${SEGMENTS.join(",")}
  -p, --print <prompt>  run without the interface
  --json            with -p, print every event as one JSON line
  --raw             with -p, print the answer exactly as written, control codes and all
  -h, --help        show this help

In a session: /lead <provider:model> switches the lead model, /login chatgpt and /logout chatgpt
sign in and out, /errors summarises the error log, /exit quits. Ctrl-C stops the current turn, or
quits when idle.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  return value as T;
}

process.stdout.on("error", endOnEpipe);
process.stderr.on("error", endOnEpipe); // `tachi -p … 2>&1 | head -1`

// `tachi login chatgpt` and `tachi logout chatgpt` do only that, then exit.
const verb = process.argv[2];
if (verb === "login" || verb === "logout") {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort()); // Ctrl-C while the browser part waits
  try {
    await accountCommand(verb, process.argv.slice(3), (line) => console.log(prose(line)), stop.signal);
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 0); // Ctrl-C can end the wait for OpenAI to cancel the sign-in, after signing out here
  } catch (err) {
    console.error(prose(errorText(err)));
    process.exit(stop.signal.aborted ? 128 + constants.signals.SIGINT : 1);
  }
}

let parsed;
try {
  parsed = parseArgs({
    options: {
      lead: { type: "string" },
      mode: { type: "string" },
      effort: { type: "string" },
      fallback: { type: "string" },
      status: { type: "string" },
      print: { type: "string", short: "p" },
      json: { type: "boolean" },
      raw: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  }).values;
} catch (err) {
  fail(`${errorText(err)}\n\n${HELP}`);
}
if (parsed.help) {
  console.log(HELP);
  process.exit(0);
}

const leadSpec = parsed.lead ?? process.env.TACHI_LEAD;
if (!leadSpec) fail(`No lead model given. Pass --lead or set TACHI_LEAD.\n\n${HELP}`);
if (parsed.print !== undefined && !parsed.print.trim()) fail("-p needs a prompt"); // a blank one would still be a paid request
if (parsed.raw && (parsed.print === undefined || parsed.json)) fail("--raw works only with -p, and not with --json, which is already exact");
if (parsed.raw) console.error("warning: --raw prints the answer exactly as the model wrote it; control codes in it can act on a terminal that shows it");
const mode: Mode = oneOf("mode", parsed.mode, MODES) ?? "ask"; // the safest mode is the default
const effort = oneOf<Effort>("effort", parsed.effort, EFFORTS);
let segments;
try {
  segments = statusSegments(parsed.status);
} catch (err) {
  fail(errorText(err));
}

const root = process.cwd();
const errorFile = path.join(root, ".tachikoma", "errors.jsonl");
const bus = new Bus();
attachErrorLog(bus, errorFile, randomUUID());
const stats = new Stats(bus);

const makeProvider = (spec: string): Provider => createProvider(spec, { effort });
let lead: Provider;
let fallback: Provider | undefined;
try {
  lead = makeProvider(leadSpec);
} catch (err) {
  fail(errorText(err));
}
try {
  if (parsed.fallback) fallback = makeProvider(parsed.fallback);
} catch (err) {
  fail(`--fallback: ${errorText(err)}`); // otherwise it reads like a bad lead
}

let declined = false;
let ask: (summary: string, detail?: string) => Promise<boolean> = async (summary) => {
  declined = true;
  console.error(
    `declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused; --mode never means no checks at all): ${summary}`,
  );
  return false;
};
const gate = new PermissionGate(mode, (summary, detail) => ask(summary, detail), parsed.print === undefined ? undefined : "Not allowed in -p mode, where nobody can approve it");
const session = new Session({ lead, fallback, tools: TOOLS, system: systemPrompt(root), ctx: { root, executor: new LocalExecutor(), gate }, bus });

// The executor stops running commands from an "exit" handler, which dying by a signal skips.
for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(128 + constants.signals[sig]));

if (parsed.print !== undefined) {
  let failed = false;
  bus.on("error", (e) => {
    if (e.kind !== "tool" && e.kind !== "fallback") failed = true;
  });
  if (parsed.json) {
    for (const event of ["message", "usage", "error", "lead"] as const) {
      bus.on(event, (data: unknown) => console.log(jsonLine(event, data)));
    }
  } else {
    bus.on("error", (e) => {
      if (e.kind === "fallback") console.error(prose(`note: ${e.message}`));
      else if (e.kind !== "tool") console.error(prose(`${e.kind}: ${e.message}`));
    });
  }
  // On macOS and Linux the running command is in its own process group, so Ctrl-C reaches only us.
  // A second Ctrl-C gets Node's default and ends at once.
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await session.send(parsed.print, stop.signal);
  if (!parsed.json) {
    const last = session.messages.at(-1);
    if (last?.role === "assistant") {
      const text = last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      const { out, note } = headlessAnswer(text, { raw: parsed.raw === true, tty: process.stdout.isTTY === true });
      console.log(out);
      if (note) console.error(note);
    }
  }
  process.exitCode = headlessExit({ aborted: stop.signal.aborted, failed, declined });
} else {
  if (!process.stdin.isTTY) fail('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.');
  // Ctrl-C reaches the interface as a key; a SIGINT here came from outside (`kill -INT`).
  process.on("SIGINT", () => process.exit(128 + constants.signals.SIGINT));
  render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode={mode}
      errorFile={errorFile}
      segments={segments}
      makeProvider={makeProvider}
      login={accountCommand}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
    { exitOnCtrlC: false },
  );
}
