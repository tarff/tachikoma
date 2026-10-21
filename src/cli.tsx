#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { render } from "ink";
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
import { type Segment, SEGMENTS } from "./tui/StatusLine.js";

const HELP = `tachi: a coding agent for your terminal

Usage:
  tachi --lead <provider:model> [options]          interactive session
  tachi --lead <provider:model> -p "<prompt>"      run one prompt, print the answer, exit

Options:
  --lead <spec>     anthropic:<model> | openai:<model> | openrouter:<model> | kimi:<model> | ollama:<model>
                    (or set TACHI_LEAD)
  --mode <mode>     when to ask before acting: ${MODES.join(" | ")} (default: ask)
  --effort <level>  Anthropic models only: ${EFFORTS.join(" | ")}
  --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
  --status <list>   status line parts, comma-separated: ${SEGMENTS.join(",")}
  -p, --print <prompt>  run without the interface
  --json            with -p, print every event as one JSON line
  -h, --help        show this help

In a session: /lead <provider:model> switches the lead model, /errors summarises the error log,
/exit quits. Ctrl-C stops the current turn, or quits when idle.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")} (got "${value}")`);
  return value as T;
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
const mode: Mode = oneOf("mode", parsed.mode, MODES) ?? "ask"; // the safest mode is the default
const effort = oneOf<Effort>("effort", parsed.effort, EFFORTS);
const segments = parsed.status === undefined ? SEGMENTS : parsed.status.split(",").map((s) => oneOf<Segment>("status", s.trim(), SEGMENTS)!);

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
  if (parsed.fallback) fallback = makeProvider(parsed.fallback);
} catch (err) {
  fail(errorText(err));
}

let ask: (summary: string) => Promise<boolean> = async (summary) => {
  console.error(`declined, nobody to ask in -p mode (use --mode never to allow): ${summary}`);
  return false;
};
const gate = new PermissionGate(mode, (summary) => ask(summary));
const session = new Session({ lead, fallback, tools: TOOLS, system: systemPrompt(root), ctx: { root, executor: new LocalExecutor(), gate }, bus });

if (parsed.print !== undefined) {
  let failed = false;
  bus.on("error", (e) => {
    if (e.kind !== "tool" && e.kind !== "fallback") failed = true;
  });
  if (parsed.json) {
    for (const event of ["message", "usage", "error", "lead"] as const) {
      bus.on(event, (data: unknown) => console.log(JSON.stringify({ event, data })));
    }
  } else {
    bus.on("error", (e) => {
      if (e.kind === "fallback") console.error(`note: ${e.message}`);
      else if (e.kind !== "tool") console.error(`${e.kind}: ${e.message}`);
    });
  }
  await session.send(parsed.print);
  if (!parsed.json) {
    const last = session.messages.at(-1);
    if (last?.role === "assistant") console.log(last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"));
  }
  process.exitCode = failed ? 1 : 0;
} else {
  render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode={mode}
      errorFile={errorFile}
      segments={segments}
      makeProvider={makeProvider}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
    { exitOnCtrlC: false },
  );
}
