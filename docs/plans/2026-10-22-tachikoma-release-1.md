# Tachikoma Release 1 (Core): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A working `tachi` command. Any of five providers can lead and the lead can be switched
mid-session. It has file and shell tools behind permission prompts, a terminal interface with a status
line, and an error log.

**Architecture:** One agent loop (`Session`) sends events on a bus. The interface, status line, headless
output and error log all listen to that bus. Providers convert a neutral message format to and from their
own API. Tools act through an executor, so release 2 can swap in Docker without touching them. Design:
`docs/plans/2026-10-22-tachikoma-design.md`.

**Tech stack:**
- Node 22+ and TypeScript 7.0.2
- Ink 7.1.1 with React 19.3.0, for the terminal interface
- `@anthropic-ai/sdk` 0.132.0 and `openai` 7.30.0
- zod 4.6.5, to check tool input
- Vitest 5.0.3 for tests, with ink-testing-library

---

## Before you start

**This plan's code has already been run.** Every code block below was copied by script from a scratch
build made on 2026-10-22, not retyped. In that build:
- it typechecked with no errors;
- 71 tests passed and the live test was skipped (3 full runs, no failures);
- the built command gave the outputs shown in Task 13.

**Changed while building** (each change is in the code below, so plan and code still match):
- `tsconfig.json` names Node's types (Task 0). The scratch build's checks ran on the finished code, where
  Vitest's types pulled them in; Task 1's typecheck runs before any test exists.
- Code review added: a bus that does not throw when nobody listens for errors (Task 1), three permission
  tests (Task 2), and an error log that turns itself off when it cannot be written (Task 10).
- Code review of the file tools (Task 4): a link that leads nowhere counts as outside the project; the
  approval prompt says where a path through a link really leads; `edit_file` refuses files that are
  not UTF-8 text instead of damaging them, and says when a file uses CRLF line endings.
- Code review of Tasks 3, 5, 6 and 7:
  - **Commands** get no input (so one that waits for it ends instead of hanging), keep at most
    30,000 characters of each output stream, decode UTF-8 correctly across chunks, report the signal
    that killed them, and are stopped when Tachikoma exits. Cancel always returns, even when a program
    the shell started still holds its output. The shell tool lists error output before normal output,
    so a long log cannot push the errors out of the 30,000-character cut.
  - **The approval prompt** shows control characters literally (`visible()` in Task 2), so terminal
    codes, carriage returns or many newlines in a command cannot disguise what will run.
  - **The agent loop** never stores a refused reply (an empty one would break every later Anthropic
    request), reports Anthropic's fallback only when it rescued the reply, and refuses a second
    `send()` while a turn is running.
  - **The Anthropic provider** follows Anthropic's server-side fallback rules (Task 7 notes), leaves
    out empty assistant messages, and retries a failed context-window lookup.
- Code review of Tasks 8, 9 and 10:
  - **OpenAI-format providers** send back the reasoning fields a provider returned (`reasoning_content`,
    `reasoning`, `reasoning_details`) when the same provider leads again, as Kimi's docs require on
    tool-call turns (platform.kimi.ai, "use thinking models", checked 2026-10-22), and never to another
    provider. Empty assistant messages are left out, `message.refusal` counts as a refusal, and a
    timeout or refused connection is named as such.
  - **Provider names** such as `constructor` are no longer mistaken for providers.
  - **The error log's reader** skips damaged lines instead of crashing `/errors`, and fits the failed
    action to the terminal width. A refusal the `--fallback` model rescues is logged once, as a
    `fallback`, and no longer counts as an error.
  - **The approval prompt** shows a line break as ⏎ (and ␍, ⇥), so a typed `\n` cannot pass for one.
- Code review of Tasks 11, 12 and 13:
  - **The scrollback** escapes everything the model controls (its text, tool names and inputs, tool
    errors, provider errors, `/errors`) in one place, so terminal codes such as clipboard writes,
    hidden text or carriage returns cannot reach the terminal. Tabs in prose stay tabs.
  - **The interactive screen**: Ctrl-C at an approval prompt answers no and stops the turn; errors
    are shown instead of ending the program; an unknown `/command` is refused instead of sent to
    the model; a prompt is answered once; a late context-window lookup cannot apply to a new lead.
    The status line shows millions as `M`.
  - **The command**: a headless run in which an action was declined exits 1; Ctrl-C in a headless
    run stops the turn and its commands and exits 130; SIGTERM and SIGHUP run the exit cleanup;
    interactive mode without a terminal says to use `-p`; a closed pipe on stdout ends quietly. The
    system prompt says the tools ask the user themselves, that Windows PowerShell 5.1 has no `&&`,
    and not to start commands that never return. The error log's folder gets its own `.gitignore`.
- That makes 157 tests in all.

**Why these versions.** Each is the newest release published at least 14 days before 2026-10-22, so a
freshly compromised release cannot slip in. That rule passed over Anthropic SDK 1.1.0 (published
yesterday) and Ink 8.0.0. Ink 7.1.1 was picked because Ink 8.0.0 is a brand-new major release.

**Numbers in the code, and where each came from:**

| Value | Source |
|---|---|
| Tool output cut at 30,000 characters | Claude Code's own Bash tool limit, used until our logs show it should move |
| `max_tokens` 64,000 on Anthropic requests | claude-api skill: the default for streamed requests |
| Anthropic prices; cache writes 1.25x input | claude-api skill model table (cached 2026-10-06) and its prompt-caching notes |
| Provider base URLs | each provider's docs, checked 2026-10-22 |

**Different from the design:**
- **The `project` permission mode** asks before every shell command and before anything outside the
  project. Writes inside the project don't ask. A shell command can touch anything, so it always asks.
- **No prices yet for OpenAI, OpenRouter or Kimi.** The status line shows `+ ?` for them rather than a
  guessed price.
- **Claude Haiku 5.5 is not priced either,** because its price changes above 100K-token prompts. It shows
  as `?` too.

**Known limits of release 1.** Each is fixed in the release named here (see the design):
- **No shortening yet** (release 3). A full context window ends the turn with an error. Switching
  `/lead` to a model with a smaller window can make the next request fail with an error.
- **No budget controller yet** (release 6). An interactive session runs until you stop it.
- **The `native` content is never removed yet.** Only shortening needs to remove it, and that comes
  in release 3.
- **File tools check a path, then use it.** Another program that swaps a folder for a link in
  between could redirect the write. A hard link inside the project to an outside file looks like an
  ordinary file. Both need something already running on the machine; the sandbox (release 2) is the
  answer.
- **On Windows, cancelling cannot stop a program whose shell has already exited** (`taskkill /T`
  cannot find a tree whose root is gone). Cancel still returns at once. On macOS and Linux the
  process-group kill reaches it.
- **Windows exit codes are 0 or 1.** PowerShell `-Command` reports only whether the last command
  succeeded, so a program's own exit code is lost.
- **Commands have no time limit**, so one that keeps its output open runs until you cancel it. A time
  limit needs data first, and comes with the budget controller (release 6). Closing the terminal
  (SIGHUP), SIGTERM, and Ctrl-C in headless mode all go through the exit cleanup, which stops running
  commands; a hard kill (SIGKILL) or a crash of Node itself does not, and on macOS and Linux a command
  then keeps going.

**Decided 2026-10-22:**
- **Licence:** MIT.
- **Refusals:** keep Anthropic's fallback and show every rescue. `--fallback <provider:model>` adds an
  optional retry on a model from another provider.

**Open question for you:** the name for MIT's copyright line (`Copyright (c) 2026 <name>`), used in
Task 14.

## Tasks

### Task 0: Project setup

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`

**Step 1: Write the config files**

`package.json` (dependencies are added by the install commands in step 2):

```json
{
  "name": "tachikoma",
  "version": "0.1.0",
  "description": "A coding-agent harness: any model can lead, with memory, a sandbox and lessons from its own mistakes.",
  "private": true,
  "type": "module",
  "bin": {
    "tachi": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev": "tsx src/cli.tsx"
  }
}
```

`private` stays `true` until the npm scope is chosen (release 8). The licence field is added in Task 14.

`tsconfig.json` (typechecks source and tests, emits nothing):

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`"types": ["node"]` is needed because TypeScript 6 and later load no `@types` packages unless they are named. The scratch build passed without it only because the finished tests import Vitest, whose type files pull in Node's types; Task 1's typecheck, which runs before any test exists, failed without it.

`tsconfig.build.json` (emits `dist/` from `src/` only):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
```

`.gitignore`:

```
node_modules/
dist/
.tachikoma/
```

**Step 2: Install the pinned dependencies**

Run each through Socket Firewall (`sfw`). `--save-exact` pins the versions, and `--ignore-scripts` stops
packages running install scripts. None of these packages need one; this was checked in the scratch build.

```bash
sfw npm install --ignore-scripts --save-exact @anthropic-ai/sdk@0.132.0 ink@7.1.1 openai@7.30.0 react@19.3.0 zod@4.6.5
sfw npm install --ignore-scripts --save-exact -D @types/node@22.20.5 @types/react@19.3.0 ink-testing-library@4.0.0 tsx@4.23.15 typescript@7.0.2 vitest@5.0.3
```

Expected: `found 0 vulnerabilities` after each. In the scratch build, the first `sfw` run sat with no
output for 15 minutes; running it again with `--loglevel=http` finished in 13 s. If it hangs, stop it and do
the same.

**Step 3: Check the toolchain**

Run: `npx tsc --version && npx vitest --version`
Expected: `Version 7.0.2` and `vitest/5.0.3`.

**Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .gitignore
git commit -m "chore: project setup"
```

### Task 1: Conversation format and event bus

Mostly types. The bus has one piece of behaviour, and one test checks it.

**Files:**
- Create: `src/core/types.ts`, `src/core/bus.ts`
- Test: `tests/core/bus.test.ts`

**Step 1: Write the code**

`src/core/types.ts`:

```typescript
// The conversation format Tachikoma stores. No provider owns it; each adapter converts to and from it.

export type Part =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: string; isError: boolean };

export type ToolCall = Extract<Part, { type: "tool_call" }>;
export type ToolResult = Extract<Part, { type: "tool_result" }>;

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
  // The provider's own content for this turn, replayed unchanged when the same kind of provider leads
  // again. Anthropic needs this: thinking blocks must come back byte-identical.
  native?: { provider: string; content: unknown };
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Token counts for one request. `input` excludes tokens read from or written to the prompt cache.
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Turn {
  parts: Part[];
  native?: Message["native"];
  usage: Usage;
  // Set when the model stopped before finishing: output limit, context limit or refusal.
  cutOff?: { kind: "max_tokens" | "refusal"; detail: string };
  // Set when the provider itself handed the request to another model (Anthropic's fallback).
  fallbacks?: { from: string; to: string }[];
  servedBy?: string; // "<provider>:<model>" that actually answered, when not the one asked
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string; // "<provider>:<model>", e.g. "anthropic:claude-opus-5-5"
  complete(req: CompletionRequest): Promise<Turn>;
  contextWindow?(): Promise<number | null>;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`src/core/bus.ts`:

```typescript
import { EventEmitter } from "node:events";
import type { Message, Usage } from "./types.js";

export interface ErrorEvent {
  kind: "tool" | "provider" | "refusal" | "max_tokens" | "fallback"; // "fallback": a refusal another model rescued
  attempted: string;
  message: string;
  lead: string;
}

export interface Events {
  message: [Message];
  usage: [{ provider: string; usage: Usage }];
  error: [ErrorEvent];
  lead: [string];
}

// The session emits; the interface, status line, headless output and error log listen.
export class Bus extends EventEmitter<Events> {
  constructor() {
    super();
    // Node throws when an "error" event has no listener. Here an error event is a report, not a crash,
    // so a session that nobody is listening to must carry on.
    this.on("error", () => {});
  }
}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit code 0.

**Step 3: Test the bus**

Node throws when an `"error"` event has no listener. On this bus an error event is a report, so the
bus listens to its own errors and a session nobody is watching carries on. Code review of the
build found this: without it, a tool error with no listener would stop the session half way through
a tool call.

`tests/core/bus.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Bus } from "../../src/core/bus.js";

describe("Bus", () => {
  it("carries on when an error is reported and nobody is listening", () => {
    const bus = new Bus();
    expect(() => bus.emit("error", { kind: "tool", attempted: "shell", message: "exit code: 1", lead: "fake:a" })).not.toThrow();
  });
});
```

Run: `npx vitest run tests/core/bus.test.ts`
Expected: 1 test passes.

**Step 4: Commit**

```bash
git add src/core/types.ts src/core/bus.ts tests/core/bus.test.ts
git commit -m "feat: conversation format and event bus"
```

### Task 2: Permission gate

Decides when to ask the user before acting. See the design, section 3.

**Files:**
- Create: `src/core/permissions.ts`
- Test: `tests/core/permissions.test.ts`

**Step 1: Write the failing test**

`tests/core/permissions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { type Action, Declined, needsApproval, PermissionGate, visible } from "../../src/core/permissions.js";

const act = (kind: Action["kind"], outside = false): Action => ({ kind, outside, summary: `${kind}${outside ? " outside" : ""}` });

describe("needsApproval", () => {
  it.each([
    ["ask", act("read"), false],
    ["ask", act("write"), true],
    ["ask", act("shell"), true],
    ["ask", act("read", true), true],
    ["project", act("read"), false],
    ["project", act("write"), false],
    ["project", act("shell"), true],
    ["project", act("write", true), true],
    ["project", act("read", true), true],
    ["never", act("shell"), false],
    ["never", act("write", true), false],
    ["never", act("read", true), false],
  ] as const)("%s mode, %o -> %s", (mode, action, expected) => {
    expect(needsApproval(mode, action)).toBe(expected);
  });
});

describe("PermissionGate", () => {
  it("throws Declined when the user says no", async () => {
    const gate = new PermissionGate("ask", async () => false);
    await expect(gate.require(act("write"))).rejects.toBeInstanceOf(Declined);
  });

  it("asks with the action's summary, and goes ahead when the user says yes", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate("ask", async (summary) => (asked.push(summary), true));
    await expect(gate.require(act("shell"))).resolves.toBeUndefined();
    expect(asked).toEqual(["shell"]);
  });

  it("does not ask when no approval is needed", async () => {
    let asked = false;
    const gate = new PermissionGate("ask", async () => (asked = true));
    await gate.require(act("read"));
    expect(asked).toBe(false);
  });
});

describe("visible", () => {
  it.each([
    ["an escape code", "echo \u001b[8mhidden", "echo \\u001b[8mhidden"],
    ["a carriage return", "rm -rf ~\rls", "rm -rf ~␍ls"],
    ["newlines", "ls\n\nrm -rf ~", "ls⏎⏎rm -rf ~"],
    ["a tab", "a\tb", "a⇥b"],
    ["a NUL", "a\u0000b", "a\\u0000b"],
    ["a C1 control", "a\u009bb", "a\\u009bb"],
    ["a delete", "a\u007fb", "a\\u007fb"],
    ["a right-to-left override", "ls \u202etxt.exe", "ls \\u202etxt.exe"],
    ["a bidi isolate", "ls \u2066x\u2069", "ls \\u2066x\\u2069"],
  ])("shows %s literally", (_, text, shown) => {
    expect(visible(text)).toBe(shown);
  });

  it("shows a real line break differently from a typed backslash-n", () => {
    // Otherwise `echo done` + a line break + `rm -rf build` would look like one harmless echo.
    expect(visible("echo done\nrm -rf build")).not.toBe(visible("echo done\\nrm -rf build"));
  });

  it("can leave tabs as tabs, for prose", () => {
    expect(visible("a\tb\u001b[8m\n", { tabs: true })).toBe("a\tb\\u001b[8m⏎");
  });

  it("leaves ordinary text alone", () => {
    expect(visible("echo café costs 5€ > out.txt")).toBe("echo café costs 5€ > out.txt");
  });

  it("is what the gate asks with", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate("ask", async (summary) => (asked.push(summary), false));
    await expect(gate.require({ kind: "shell", outside: false, summary: "run: ls\rrm -rf ~" })).rejects.toThrow("run: ls␍rm -rf ~");
    expect(asked).toEqual(["run: ls␍rm -rf ~"]);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/permissions.test.ts`
Expected: FAIL, cannot find module `../../src/core/permissions.js`

**Step 3: Write the code**

`src/core/permissions.ts`:

```typescript
// ask:     ask before every write and shell command, and before anything outside the project
// project: ask before shell commands and anything outside the project
// never:   never ask (meant for the Docker sandbox)
export type Mode = "ask" | "project" | "never";
export const MODES: Mode[] = ["ask", "project", "never"];

export interface Action {
  kind: "read" | "write" | "shell";
  outside: boolean;
  summary: string;
}

export function needsApproval(mode: Mode, action: Action): boolean {
  if (mode === "never") return false;
  if (action.outside) return true;
  if (mode === "ask") return action.kind !== "read";
  return action.kind === "shell";
}

// Symbols, not \n-style escapes: a typed backslash-n must not look like a real line break, or two
// commands could pass for one.
const NAMED: Record<string, string> = { "\n": "⏎", "\r": "␍", "\t": "⇥" };

// Shows control characters as escapes, so the approval prompt shows what will run: escape codes can
// hide or recolour text, \r and many \n can push part of a command out of sight, and bidi overrides
// can reorder it. `tabs` keeps tabs as they are, for prose in the scrollback.
export function visible(text: string, opts: { tabs?: boolean } = {}): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (c) =>
    opts.tabs && c === "\t" ? c : (NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
  );
}

// Thrown when the user says no. The model is told; it is not logged as an error.
export class Declined extends Error {}

export class PermissionGate {
  constructor(
    readonly mode: Mode,
    private readonly ask: (summary: string) => Promise<boolean>,
  ) {}

  async require(action: Action): Promise<void> {
    if (!needsApproval(this.mode, action)) return;
    const shown = visible(action.summary);
    if (!(await this.ask(shown))) throw new Declined(`The user declined: ${shown}`);
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/core/permissions.test.ts && npm run typecheck`
Expected: 28 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/core/permissions.ts tests/core/permissions.test.ts
git commit -m "feat: permission gate"
```

### Task 3: Executor, tool definition and test helpers

The executor is the switch that the Docker sandbox will plug into later (release 2). `defineTool` checks
model input against a schema before any tool runs. The helpers file gives every later test a scripted
model (`FakeProvider`) and a temporary project folder.

Cancelling a command must stop everything it started, not just the shell. Otherwise a cancelled
`npm test` keeps running. This came out of review: the first version passed `signal` to `spawn`, which
kills only the shell, and the test below caught the program the shell had started still running.

**Files:**
- Create: `src/exec/executor.ts`, `src/exec/local.ts`, `src/tools/tool.ts`
- Test: `tests/helpers.ts`, `tests/exec/local.test.ts`

**Step 1: Write the helpers and the failing test**

`tests/helpers.ts`:

```typescript
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bus, type ErrorEvent } from "../src/core/bus.js";
import { type Mode, PermissionGate } from "../src/core/permissions.js";
import type { CompletionRequest, Message, Part, Provider, Turn, Usage } from "../src/core/types.js";
import { LocalExecutor } from "../src/exec/local.js";
import type { ToolContext } from "../src/tools/tool.js";

export const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
export const reply = (text: string): Turn => ({ parts: [{ type: "text", text }], usage });
export const callTool = (id: string, name: string, input: unknown): Turn => ({ parts: [{ type: "tool_call", id, name, input }], usage });

// Replays scripted turns and records what it was sent.
export class FakeProvider implements Provider {
  readonly id: string;
  readonly seen: Message[][] = [];
  constructor(
    name: string,
    private readonly turns: (Turn | Error)[],
  ) {
    this.id = `fake:${name}`;
  }
  async complete(req: CompletionRequest): Promise<Turn> {
    this.seen.push(structuredClone(req.messages));
    const next = this.turns.shift();
    if (!next) throw new Error("FakeProvider ran out of turns");
    if (next instanceof Error) throw next;
    return next;
  }
}

export function collectErrors(bus: Bus): ErrorEvent[] {
  const errors: ErrorEvent[] = [];
  bus.on("error", (e) => errors.push(e));
  return errors;
}

export async function tempContext(mode: Mode = "never", answers: boolean[] = []): Promise<ToolContext & { asked: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const asked: string[] = [];
  const gate = new PermissionGate(mode, async (summary) => {
    asked.push(summary);
    return answers.shift() ?? false;
  });
  return { root, executor: new LocalExecutor(), gate, asked };
}

export const texts = (m: Message) => m.parts.flatMap((p: Part) => (p.type === "text" ? [p.text] : []));
export { Bus };
```

`tests/exec/local.test.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { LocalExecutor } from "../../src/exec/local.js";
import { tempContext } from "../helpers.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Waits for a script to record its pid. An empty file reads as 0, which would mean our own process group.
async function readPid(file: string): Promise<number> {
  let pid = 0;
  for (let i = 0; i < 100 && !(pid > 0); i++) {
    await new Promise((r) => setTimeout(r, 50));
    pid = existsSync(file) ? Number(readFileSync(file, "utf8")) : 0;
  }
  return pid;
}

// Scripts are written to files so the same command works in sh and PowerShell.
async function script(source: string): Promise<string> {
  const { root } = await tempContext();
  await writeFile(path.join(root, "script.js"), source);
  return root;
}

describe("LocalExecutor", () => {
  it("cancelling a command also stops the programs it started", async () => {
    const { root } = await tempContext();
    // A grandchild: the shell starts node, which records its pid and waits.
    await writeFile(path.join(root, "child.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node child.js", root, abort.signal);
    const pid = await readPid(path.join(root, "pid"));
    expect(alive(pid)).toBe(true);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it("cancel returns even when a program the shell started still holds the output pipes", async () => {
    const { root } = await tempContext();
    await writeFile(path.join(root, "grandchild.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    // The launcher leaves the grandchild running on its inherited pipes and exits. On POSIX it is not
    // detached, so it stays in the shell's process group. On Windows it must be, or Node kills it when
    // the launcher exits.
    await writeFile(
      path.join(root, "launcher.js"),
      `require("child_process").spawn(process.execPath, ["grandchild.js"], { stdio: "inherit", detached: process.platform === "win32" }).unref();`,
    );
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node launcher.js", root, abort.signal);
    const pid = await readPid(path.join(root, "pid"));
    onTestFinished(() => {
      if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
    });
    expect(pid).toBeGreaterThan(0);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    // Windows cannot find a tree whose root has exited, so the grandchild survives there.
    if (process.platform !== "win32") {
      for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(alive(pid)).toBe(false);
    }
  }, 15_000);

  it("gives commands no input, so ones that read to the end of input finish", async () => {
    const root = await script(`process.stdin.resume(); process.stdin.on("end", () => console.log("eof"));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    expect(r.stdout).toContain("eof");
  }, 15_000);

  it("keeps at most MAX_TOOL_OUTPUT characters of a stream and says how much it cut", async () => {
    const root = await script(`process.stdout.write("x".repeat(${MAX_TOOL_OUTPUT * 3}));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    const [kept, marker] = r.stdout.split("\n[cut: ");
    expect(kept).toBe("x".repeat(MAX_TOOL_OUTPUT));
    expect(marker).toMatch(/^\d+ more characters\]$/);
  }, 15_000);

  it("decodes characters split across chunks", async () => {
    // 3 bytes each, so some are certain to straddle a chunk boundary.
    const root = await script(`process.stdout.write("€".repeat(300000));`);
    const r = await new LocalExecutor().exec("node script.js", root);
    const [kept] = r.stdout.split("\n[cut: ");
    expect(r.stdout).not.toContain("�");
    expect(kept).toBe("€".repeat(MAX_TOOL_OUTPUT));
  }, 15_000);
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/exec/local.test.ts`
Expected: FAIL, cannot find module `../../src/exec/local.js`

**Step 3: Write the code**

`src/exec/executor.ts`:

```typescript
// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

export interface ExecResult {
  code: number | null;
  signal: NodeJS.Signals | null; // set when the command was killed by a signal
  stdout: string;
  stderr: string;
}

// Everything a tool does to the machine goes through here, so the Docker sandbox can replace it.
export interface Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult>;
  readFile(abs: string): Promise<string>;
  writeFile(abs: string, content: string): Promise<void>;
}
```

`src/exec/local.ts`:

```typescript
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { type ExecResult, type Executor, MAX_TOOL_OUTPUT } from "./executor.js";

export function shellFor(platform: NodeJS.Platform = process.platform): { name: string; argv: (command: string) => string[] } {
  if (platform === "win32") {
    return {
      name: "PowerShell",
      // Without this PowerShell writes the console code page, which garbles anything outside ASCII.
      argv: (c) => ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${c}`],
    };
  }
  return { name: "sh", argv: (c) => ["/bin/sh", "-c", c] };
}

// Stops the shell and everything it started. Killing only the shell would leave its children running.
// Runs even after the shell has exited: what it started may still be going.
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // taskkill cannot find a tree whose root has exited, and Windows may already have given that pid
    // to an unrelated program, so it is only run while the shell is alive.
    if (child.exitCode === null && child.signalCode === null) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // the shell leads its own process group (detached below)
    } catch {
      // ESRCH: the group is gone. Throwing here would crash Node from inside an abort listener.
    }
  }
}

// Detached commands are cut off from the terminal and would outlive us, so we stop them on exit.
const running = new Set<ChildProcess>();
process.on("exit", () => running.forEach(killTree));

// Keeps the first MAX_TOOL_OUTPUT characters and reads (and drops) the rest, so the command never
// blocks on a full pipe and a flood of output cannot exhaust memory.
function collect(stream: Readable): () => string {
  let text = "";
  let dropped = 0;
  stream.setEncoding("utf8"); // decodes characters split across chunks
  stream.on("data", (d: string) => {
    const room = MAX_TOOL_OUTPUT - text.length;
    text += d.slice(0, room);
    dropped += Math.max(0, d.length - room);
  });
  return () => (dropped ? `${text}\n[cut: ${dropped} more characters]` : text);
}

export class LocalExecutor implements Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    const [file, ...args] = shellFor().argv(command);
    return new Promise((resolve, reject) => {
      // No stdin: a command waiting for input would otherwise wait forever.
      const child = spawn(file!, args, { cwd, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      const done = () => {
        running.delete(child);
        signal?.removeEventListener("abort", onAbort);
        child.off("close", onClose);
      };
      // Settles at once: "close" waits for every holder of the pipes, and a program the shell
      // started may hold them for good.
      const onAbort = () => {
        killTree(child);
        done();
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error("Cancelled"));
      };
      const onClose = (code: number | null, sig: NodeJS.Signals | null) => {
        done();
        resolve({ code, signal: sig, stdout: stdout(), stderr: stderr() });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (e) => {
        done();
        reject(e);
      });
      child.on("close", onClose);
    });
  }

  readFile(abs: string): Promise<string> {
    return readFile(abs, "utf8");
  }

  async writeFile(abs: string, content: string): Promise<void> {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}
```

`src/tools/tool.ts`:

```typescript
import { z } from "zod";
import type { PermissionGate } from "../core/permissions.js";
import type { ToolSpec } from "../core/types.js";
import type { Executor } from "../exec/executor.js";

export interface ToolContext {
  root: string;
  executor: Executor;
  gate: PermissionGate;
  signal?: AbortSignal;
}

export interface Tool {
  spec: ToolSpec;
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

// A tool whose input is checked against its schema before it runs. Model output is untrusted.
// An object schema, because both provider APIs require one for tool input.
export function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>,
): Tool {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    spec: { name, description, inputSchema },
    async run(input, ctx) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new Error(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
      return run(parsed.data, ctx);
    },
  };
}
```

**Step 4: Run the test and the typecheck**

Run: `npx vitest run tests/exec/local.test.ts && npm run typecheck`
Expected: 5 tests pass, and no type errors. On Windows this kills the tree with `taskkill /T`. On macOS
and Linux it kills the shell's process group; that path is first run by the release 8 install test.

**Step 5: Commit**

```bash
git add src/exec/executor.ts src/exec/local.ts src/tools/tool.ts tests/helpers.ts tests/exec/local.test.ts
git commit -m "feat: executor that cancels whole process trees, tool definition, test helpers"
```

### Task 4: File tools

`read_file`, `write_file` and `edit_file`. Paths outside the project always ask, except in `never` mode.

**Files:**
- Create: `src/tools/files.ts`
- Test: `tests/tools/files.test.ts`

**Step 1: Write the failing test**

`tests/tools/files.test.ts`:

```typescript
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editFileTool, readFileTool, resolveIn, writeFileTool } from "../../src/tools/files.js";
import { tempContext } from "../helpers.js";

describe("resolveIn", () => {
  it("marks paths that leave the project", () => {
    const root = path.resolve("/proj");
    expect(resolveIn(root, "a/b.txt").outside).toBe(false);
    expect(resolveIn(root, "../x").outside).toBe(true);
    expect(resolveIn(root, path.resolve("/elsewhere/x")).outside).toBe(true);
    expect(resolveIn(root, "..foo").outside).toBe(false); // a file named "..foo" is inside
  });
});

describe("file tools", () => {
  it("writes, then reads back", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "sub/a.txt", content: "hello" }, ctx);
    expect(await readFileTool.run({ path: "sub/a.txt" }, ctx)).toBe("hello");
  });

  it("edits one unique match", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "one two three" }, ctx);
    await editFileTool.run({ path: "a.txt", old_text: "two", new_text: "$&2" }, ctx);
    expect(await readFile(path.join(ctx.root, "a.txt"), "utf8")).toBe("one $&2 three");
  });

  it("refuses an edit that matches nothing or more than once", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "x x" }, ctx);
    await expect(editFileTool.run({ path: "a.txt", old_text: "y", new_text: "z" }, ctx)).rejects.toThrow("was not found");
    await expect(editFileTool.run({ path: "a.txt", old_text: "x", new_text: "z" }, ctx)).rejects.toThrow("appears 2 times");
  });

  it("rejects input that does not match the schema", async () => {
    const ctx = await tempContext();
    await expect(writeFileTool.run({ path: "a.txt" }, ctx)).rejects.toThrow("Invalid input for write_file");
  });

  it("asks before writing outside the project in project mode", async () => {
    const ctx = await tempContext("project", [false]);
    await expect(writeFileTool.run({ path: "../escape.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(1);
  });

  it("treats a path through a link that leads out of the project as outside", async () => {
    const ctx = await tempContext("project", [false]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    // A junction needs no special rights on Windows; on other systems this makes a directory symlink.
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    expect(resolveIn(ctx.root, "linked/x.txt").outside).toBe(true);
    await expect(writeFileTool.run({ path: "linked/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(1);
  });

  it("shows where a path through a link really leads when asking", async () => {
    const ctx = await tempContext("project", [false]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    await expect(writeFileTool.run({ path: "linked/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked[0]).toContain(`(really ${path.join(realpathSync(elsewhere), "x.txt")})`);
  });

  it("treats a link that leads nowhere as outside", async () => {
    // A write through it could create its missing target, wherever that is.
    const ctx = await tempContext("project", [false]);
    const missing = path.join(tmpdir(), `tachi-missing-${process.pid}-${Date.now()}`);
    await symlink(missing, path.join(ctx.root, "dangling"), "junction");
    expect(resolveIn(ctx.root, "dangling/x.txt").outside).toBe(true);
    await expect(writeFileTool.run({ path: "dangling/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
  });

  it("asks before reading or editing a file outside the project, given by absolute path", async () => {
    const ctx = await tempContext("project", [false, false]);
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "tachi-outside-")), "a.txt");
    await writeFile(outside, "one");
    await expect(readFileTool.run({ path: outside }, ctx)).rejects.toThrow("The user declined");
    await expect(editFileTool.run({ path: outside, old_text: "one", new_text: "two" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(2);
    expect(await readFile(outside, "utf8")).toBe("one");
  });

  it("refuses to edit a file that is not UTF-8 text, leaving it unchanged", async () => {
    const ctx = await tempContext();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6c, 0x64]); // "café old" in Latin-1
    await writeFile(path.join(ctx.root, "a.txt"), latin1);
    await expect(editFileTool.run({ path: "a.txt", old_text: "old", new_text: "new" }, ctx)).rejects.toThrow("not UTF-8 text");
    expect(await readFile(path.join(ctx.root, "a.txt"))).toEqual(latin1);
  });

  it("mentions Windows line endings when an edit finds nothing", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "one\r\ntwo" }, ctx);
    await expect(editFileTool.run({ path: "a.txt", old_text: "one\ntwo", new_text: "x" }, ctx)).rejects.toThrow("CRLF line endings");
  });

  it("treats a new file in a new folder inside the project as inside", async () => {
    const ctx = await tempContext();
    await mkdir(path.join(ctx.root, "real"));
    expect(resolveIn(ctx.root, "real/new/deeper/x.txt").outside).toBe(false);
  });

  it("writes inside the project without asking in project mode", async () => {
    const ctx = await tempContext("project");
    await writeFileTool.run({ path: "a.txt", content: "x" }, ctx);
    expect(ctx.asked).toEqual([]);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tools/files.test.ts`
Expected: FAIL, cannot find module `../../src/tools/files.js`

**Step 3: Write the code**

`src/tools/files.ts`:

```typescript
import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./tool.js";

// Where a path really leads, following symlinks and Windows junctions. Parts that don't exist yet
// (a new file in a new folder) are added back onto the deepest part that does. Null for a link that
// leads nowhere: writing through it could create its missing target, wherever that is.
function realTarget(abs: string): string | null {
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    if (lstatSync(existing, { throwIfNoEntry: false })) return null;
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
}

// `shown` is what the approval prompt names: the path, plus where it really leads when a link takes
// it somewhere else.
export function resolveIn(root: string, p: string): { abs: string; outside: boolean; shown: string } {
  const abs = path.resolve(root, p);
  const base = realTarget(root);
  const real = realTarget(abs);
  if (base === null || real === null) return { abs, outside: true, shown: `${abs} (through a link that leads nowhere)` };
  const rel = path.relative(base, real);
  // On Windows a path on another drive comes back absolute.
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return { abs, outside, shown: rel === path.relative(root, abs) ? abs : `${abs} (really ${real})` };
}

export const readFileTool = defineTool(
  "read_file",
  "Read a text file. Paths are relative to the project root.",
  z.object({ path: z.string() }),
  async ({ path: p }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "read", outside, summary: `read ${shown}` });
    return ctx.executor.readFile(abs);
  },
);

export const writeFileTool = defineTool(
  "write_file",
  "Create or overwrite a text file. Paths are relative to the project root.",
  z.object({ path: z.string(), content: z.string() }),
  async ({ path: p, content }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "write", outside, summary: `write ${shown}` });
    await ctx.executor.writeFile(abs, content);
    return `Wrote ${content.length} characters to ${p}`;
  },
);

export const editFileTool = defineTool(
  "edit_file",
  "Replace one exact, unique piece of text in a file. Read the file first.",
  z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
  async ({ path: p, old_text, new_text }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "write", outside, summary: `edit ${shown}` });
    const text = await ctx.executor.readFile(abs);
    // Bytes that are not UTF-8 read back as U+FFFD, and writing the text back would destroy them.
    if (text.includes("�")) throw new Error(`${p} is not UTF-8 text, so edit_file would damage it`);
    const count = text.split(old_text).length - 1;
    const crlf = text.includes("\r\n") ? " (the file uses CRLF line endings)" : "";
    if (count === 0) throw new Error(`old_text was not found in ${p}${crlf}`);
    if (count > 1) throw new Error(`old_text appears ${count} times in ${p}; include more surrounding text so it is unique`);
    await ctx.executor.writeFile(abs, text.replace(old_text, () => new_text));
    return `Edited ${p}`;
  },
);
```

The replacement in `edit_file` is passed as a function so `$&` and similar sequences in the new text are written literally (the test checks this).

`resolveIn` decides inside or outside by where a path really leads, after following symlinks and Windows junctions. This came out of review: with plain `path.resolve`, a junction inside the project that pointed elsewhere let `write_file` write outside without asking. The junction test caught it.

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/tools/files.test.ts && npm run typecheck`
Expected: 14 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/tools/files.ts tests/tools/files.test.ts
git commit -m "feat: file tools"
```

### Task 5: Shell tool and tool list

Runs PowerShell on Windows and `sh` elsewhere. A non-zero exit is an error, so it reaches the error log.

**Files:**
- Create: `src/tools/shell.ts`
- Create: `src/tools/index.ts`
- Test: `tests/tools/shell.test.ts`

**Step 1: Write the failing test**

`tests/tools/shell.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { shellTool } from "../../src/tools/shell.js";
import { tempContext } from "../helpers.js";

// `echo` and `exit` behave the same in sh and PowerShell.
describe("shell tool", () => {
  it("returns the output of a command", async () => {
    const ctx = await tempContext();
    const out = await shellTool.run({ command: "echo hi" }, ctx);
    expect(out).toContain("exit code: 0");
    expect(out).toContain("hi");
  });

  it("treats a non-zero exit as an error", async () => {
    const ctx = await tempContext();
    await expect(shellTool.run({ command: "exit 3" }, ctx)).rejects.toThrow("exit code: 3");
  });

  it("puts stderr before stdout, so a long stdout cannot push the errors out of the cut", async () => {
    const ctx = await tempContext();
    const out = await shellTool.run({ command: "echo hi" }, ctx);
    expect(out.indexOf("--- stderr ---")).toBeLessThan(out.indexOf("--- stdout ---"));
    expect(out.indexOf("exit code: 0")).toBe(0);
  });

  it("says which signal killed a command instead of a null exit code", async () => {
    const ctx = await tempContext();
    const executor = { ...ctx.executor, exec: async () => ({ code: null, signal: "SIGKILL" as const, stdout: "", stderr: "" }) };
    const run = shellTool.run({ command: "sleep 100" }, { ...ctx, executor });
    await expect(run).rejects.toThrow("killed by SIGKILL");
    await expect(run).rejects.not.toThrow("exit code");
  });

  it("always asks in project mode", async () => {
    const ctx = await tempContext("project", [true]);
    await shellTool.run({ command: "echo hi" }, ctx);
    expect(ctx.asked).toEqual(["run: echo hi"]);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tools/shell.test.ts`
Expected: FAIL, cannot find module `../../src/tools/shell.js`

**Step 3: Write the code**

`src/tools/shell.ts`:

```typescript
import { z } from "zod";
import { shellFor } from "../exec/local.js";
import { defineTool } from "./tool.js";

export const shellTool = defineTool(
  "shell",
  `Run a command with ${shellFor().name} in the project root and return its output.`,
  z.object({ command: z.string().min(1) }),
  async ({ command }, ctx) => {
    await ctx.gate.require({ kind: "shell", outside: false, summary: `run: ${command}` });
    const r = await ctx.executor.exec(command, ctx.root, ctx.signal);
    const status = r.signal ? `killed by ${r.signal}` : `exit code: ${r.code}`;
    // stderr first: the session keeps only the start of a long result, and the errors matter most.
    const out = `${status}\n--- stderr ---\n${r.stderr}\n--- stdout ---\n${r.stdout}`;
    // A failing command is an error: the model sees it flagged, and it goes in the error log.
    if (r.code !== 0) throw new Error(out);
    return out;
  },
);
```

`src/tools/index.ts`:

```typescript
import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { shellTool } from "./shell.js";
import type { Tool } from "./tool.js";

export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool];
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/tools/shell.test.ts && npm run typecheck`
Expected: 5 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/tools/shell.ts src/tools/index.ts tests/tools/shell.test.ts
git commit -m "feat: shell tool"
```

### Task 6: Agent loop

The session sends the conversation to the lead model, runs any tool calls, and repeats until the model
answers without calling a tool.

**When a model refuses** (design, "When a model refuses"):
- If the user set `--fallback`, the refused reply is thrown away and the same request is retried on
  that model, which can be from another provider.
- Every rescue, whether by Anthropic's fallback or by ours, is logged as a `fallback` entry and shown
  in the scrollback.
- The refused attempt's usage is still reported, because it is billed.

Three rules come from the Anthropic API notes:
- **The history only grows.** Earlier messages are never edited, and the system prompt is fixed for the
  session. Editing either would break prompt caching, and on newer Anthropic accounts it makes replayed
  thinking blocks fail with a 400.
- **Every tool call gets a result,** even when the response was cut off. Otherwise the next request is
  rejected.
- **Tools run one at a time,** so permission prompts never overlap. All results go back together in one
  message.

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/core/session.test.ts`

**Step 1: Write the failing test**

`tests/core/session.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Declined } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { defineTool } from "../../src/tools/tool.js";
import { Bus, FakeProvider, callTool, collectErrors, reply, tempContext, usage } from "../helpers.js";

const echo = defineTool("echo", "Echo text back", z.object({ text: z.string() }), async ({ text }) => text);
const boom = defineTool("boom", "Always fails", z.object({}), async () => {
  throw new Error("it broke");
});
const shy = defineTool("shy", "Always declined", z.object({}), async () => {
  throw new Declined("The user declined: shy");
});

async function setup(turns: ConstructorParameters<typeof FakeProvider>[1]) {
  const bus = new Bus();
  const lead = new FakeProvider("a", turns);
  const ctx = await tempContext();
  const session = new Session({ lead, tools: [echo, boom, shy], system: "test", ctx, bus });
  return { bus, lead, session, errors: collectErrors(bus) };
}

describe("Session", () => {
  it("stores the user's message and the reply", async () => {
    const { session } = await setup([reply("hello")]);
    await session.send("hi");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("runs a tool and sends its result back before the final reply", async () => {
    const { session, lead } = await setup([callTool("c1", "echo", { text: "ping" }), reply("done")]);
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session.messages[2]!.parts).toEqual([{ type: "tool_result", callId: "c1", output: "ping", isError: false }]);
    expect(lead.seen).toHaveLength(2);
  });

  it("turns a failing tool into an error result and logs it", async () => {
    const { session, errors } = await setup([callTool("c1", "boom", {}), reply("sorry")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "it broke" });
    expect(errors).toEqual([expect.objectContaining({ kind: "tool", message: "it broke", lead: "fake:a" })]);
  });

  it("cuts a very long tool input in the error it reports", async () => {
    const text = "x".repeat(MAX_TOOL_OUTPUT + 5);
    const { session, errors } = await setup([callTool("c1", "nope", { text }), reply("ok")]);
    await session.send("go");
    const full = `nope ${JSON.stringify({ text })}`;
    expect(errors[0]!.attempted).toBe(`${full.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${full.length - MAX_TOOL_OUTPUT} more characters]`);
  });

  it("reports an unknown tool to the model", async () => {
    const { session, errors } = await setup([callTool("c1", "nope", {}), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "Unknown tool: nope" });
    expect(errors).toHaveLength(1);
  });

  it("tells the model about bad tool input", async () => {
    const { session } = await setup([callTool("c1", "echo", { text: 3 }), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: expect.stringContaining("Invalid input for echo") });
  });

  it("does not log a declined action as an error", async () => {
    const { session, errors } = await setup([callTool("c1", "shy", {}), reply("ok")]);
    await session.send("go");
    expect(session.messages[2]!.parts[0]).toMatchObject({ isError: true, output: "The user declined: shy" });
    expect(errors).toEqual([]);
  });

  it("does not log a tool cancelled by the user as an error", async () => {
    const abort = new AbortController();
    const slow = defineTool("slow", "Waits to be cancelled", z.object({}), async (_, ctx) => {
      abort.abort();
      throw new Error(ctx.signal?.aborted ? "Cancelled" : "not cancelled");
    });
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [callTool("c1", "slow", {})]), tools: [slow], system: "t", ctx: await tempContext(), bus });
    await session.send("go", abort.signal);
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ isError: true, output: "Cancelled by the user." });
    expect(errors).toEqual([]);
  });

  it("retries a refused turn on the fallback provider and says so", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const seen: string[] = [];
    bus.on("usage", (u) => seen.push(u.provider));
    const rescue = new FakeProvider("b", [reply("answered by b")]);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: rescue, tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "answered by b" }]);
    expect(errors.map((e) => e.kind)).toEqual(["fallback"]); // the rescued refusal is reported only as the rescue
    expect(errors[0]!.message).toBe("fake:a declined; fake:b answered instead");
    expect(seen).toEqual(["fake:a", "fake:b"]); // the refused attempt is billed too
  });

  it("does not count a rescued refusal in the status line's errors", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const stats = new Stats(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [reply("answered by b")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(stats.errors).toBe(0);
    expect(stats.fallbacks).toBe(1);
  });

  it("still reports the refusal when the fallback provider's request fails", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [new Error("rate limited")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["provider", "request to fake:b", "rate limited"],
      ["refusal", "response from fake:a", "declined"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("stops when the fallback provider refuses as well", async () => {
    const refused = (p: string) => ({ ...reply(""), cutOff: { kind: "refusal" as const, detail: `${p} declined` } });
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused("a")]), fallback: new FakeProvider("b", [refused("b")]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["refusal", "response from fake:a", "a declined"],
      ["refusal", "response from fake:b", "b declined"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("never stores a refused reply when there is no fallback", async () => {
    // A refusal mid-stream can leave a half-written tool call; it must not be stored or run.
    const refused = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const { session, errors } = await setup([refused]);
    await session.send("go");
    expect(session.messages.map((m) => m.role)).toEqual(["user"]);
    expect(errors).toEqual([expect.objectContaining({ kind: "refusal", attempted: "response from fake:a", message: "declined" })]);
  });

  it("does not report Anthropic's fallback when its reply is still a refusal", async () => {
    const turn = { ...reply(""), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }], cutOff: { kind: "refusal" as const, detail: "declined" } };
    const { session, errors } = await setup([turn]);
    await session.send("go");
    expect(errors.map((e) => e.kind)).toEqual(["refusal"]);
  });

  it("reports Anthropic's own fallback inside the fallback provider's reply", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const rescued = { ...reply("answered"), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }] };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [rescued]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["fallback", "response from fake:a", "fake:a declined; fake:b answered instead"],
      ["fallback", "response from fake:b", "claude-opus-5-5 declined; claude-opus-4-8 answered instead (Anthropic's fallback)"],
    ]);
  });

  it("reports the rescue when the fallback provider's reply is cut off", async () => {
    const refused = { ...reply(""), cutOff: { kind: "refusal" as const, detail: "declined" } };
    const cut = { ...reply("partial"), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: new FakeProvider("a", [refused]), fallback: new FakeProvider("b", [cut]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors.map((e) => [e.kind, e.attempted, e.message])).toEqual([
      ["fallback", "response from fake:a", "fake:a declined; fake:b answered instead"],
      ["max_tokens", "response from fake:b", "limit"],
    ]);
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.messages[1]!.parts).toEqual([{ type: "text", text: "partial" }]);
  });

  it("refuses a second send while a turn is running", async () => {
    const { session } = await setup([reply("first"), reply("second")]);
    const first = session.send("one");
    await expect(session.send("two")).rejects.toThrow("A turn is already running");
    await first;
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    await session.send("three"); // the turn has ended, so sending works again
    expect(session.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("reports when Anthropic's own fallback answered", async () => {
    const bus = new Bus();
    const errors = collectErrors(bus);
    const seen: string[] = [];
    bus.on("usage", (u) => seen.push(u.provider));
    const turn = { ...reply("hi"), fallbacks: [{ from: "claude-opus-5-5", to: "claude-opus-4-8" }], servedBy: "anthropic:claude-opus-4-8" };
    const session = new Session({ lead: new FakeProvider("a", [turn]), tools: [], system: "t", ctx: await tempContext(), bus });
    await session.send("go");
    expect(errors).toEqual([expect.objectContaining({ kind: "fallback", message: "claude-opus-5-5 declined; claude-opus-4-8 answered instead (Anthropic's fallback)" })]);
    expect(seen).toEqual(["anthropic:claude-opus-4-8"]); // priced as the model that answered
  });

  it("logs a provider failure without throwing", async () => {
    const { session, errors } = await setup([new Error("rate limited")]);
    await session.send("go");
    expect(errors).toEqual([expect.objectContaining({ kind: "provider", message: "rate limited" })]);
  });

  it("answers every tool call when a response is cut off", async () => {
    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
    const { session, errors } = await setup([cut]);
    await session.send("go");
    expect(session.messages.at(-1)!.parts[0]).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    expect(errors).toEqual([expect.objectContaining({ kind: "max_tokens", message: "limit" })]);
  });

  it("cuts very long tool output", async () => {
    const { session } = await setup([callTool("c1", "echo", { text: "x".repeat(MAX_TOOL_OUTPUT + 5) }), reply("ok")]);
    await session.send("go");
    const out = (session.messages[2]!.parts[0] as { output: string }).output;
    expect(out).toContain("[cut: 5 more characters]");
  });

  it("hands the whole history to a new lead", async () => {
    const { session, bus } = await setup([reply("first")]);
    await session.send("one");
    const b = new FakeProvider("b", [reply("second")]);
    const leads: string[] = [];
    bus.on("lead", (id) => leads.push(id));
    session.setLead(b);
    await session.send("two");
    expect(leads).toEqual(["fake:b"]);
    expect(b.seen[0]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("reports usage for every request", async () => {
    const { session, bus } = await setup([reply("hi")]);
    const seen: unknown[] = [];
    bus.on("usage", (u) => seen.push(u));
    await session.send("go");
    expect(seen).toEqual([{ provider: "fake:a", usage }]);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/session.test.ts`
Expected: FAIL, cannot find module `../../src/core/session.js`

**Step 3: Write the code**

`src/core/session.ts`:

```typescript
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import type { Tool, ToolContext } from "../tools/tool.js";
import type { Bus } from "./bus.js";
import { Declined } from "./permissions.js";
import { errorText, type Message, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";

function truncate(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT ? s : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}

export interface SessionOptions {
  lead: Provider;
  fallback?: Provider; // retries a turn the lead refused; chosen by the user, never by default
  tools: Tool[];
  system: string; // fixed for the whole session: prompt caching and Anthropic thinking blocks need it unchanged
  ctx: Omit<ToolContext, "signal">;
  bus: Bus;
}

export class Session {
  // Append-only. Earlier messages are never edited, for the same reason the system prompt is fixed.
  readonly messages: Message[] = [];
  #lead: Provider;
  #running = false;

  constructor(private readonly opts: SessionOptions) {
    this.#lead = opts.lead;
  }

  get lead(): Provider {
    return this.#lead;
  }

  setLead(provider: Provider): void {
    this.#lead = provider;
    this.opts.bus.emit("lead", provider.id);
  }

  async send(text: string, signal?: AbortSignal): Promise<void> {
    // Two turns at once would interleave their messages and tool results in the history.
    if (this.#running) throw new Error("A turn is already running");
    this.#running = true;
    try {
      await this.#turn(text, signal);
    } finally {
      this.#running = false;
    }
  }

  async #turn(text: string, signal?: AbortSignal): Promise<void> {
    const { bus } = this.opts;
    this.#push({ role: "user", parts: [{ type: "text", text }] });

    for (;;) {
      const lead = this.#lead;
      let answeredBy = lead;
      let turn = await this.#request(lead, signal);
      if (!turn) return;
      const rescue = this.opts.fallback;
      if (turn.cutOff?.kind === "refusal" && rescue) {
        // The refused reply is discarded, never stored, so the history stays append-only.
        const refused = { kind: "refusal", attempted: `response from ${lead.id}`, message: turn.cutOff.detail, lead: lead.id } as const;
        answeredBy = rescue;
        turn = await this.#request(rescue, signal);
        // A rescued refusal is reported only as the rescue, so the status line does not count it as an error.
        if (!turn || turn.cutOff?.kind === "refusal") bus.emit("error", refused);
        else bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${lead.id} declined; ${rescue.id} answered instead`, lead: lead.id });
        if (!turn) return;
      }
      if (turn.cutOff?.kind === "refusal") {
        // Never stored, on any path: the output may be empty or half-written, and an empty assistant
        // message makes every later Anthropic request fail, with no way to remove it.
        bus.emit("error", { kind: "refusal", attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        return;
      }
      // Reported only now, so a model that still refused is never shown as having answered.
      for (const f of turn.fallbacks ?? []) {
        bus.emit("error", { kind: "fallback", attempted: `response from ${answeredBy.id}`, message: `${f.from} declined; ${f.to} answered instead (Anthropic's fallback)`, lead: lead.id });
      }
      this.#push({ role: "assistant", parts: turn.parts, native: turn.native });

      const calls = turn.parts.filter((p) => p.type === "tool_call");
      if (turn.cutOff) {
        bus.emit("error", { kind: turn.cutOff.kind, attempted: `response from ${answeredBy.id}`, message: turn.cutOff.detail, lead: lead.id });
        // Every tool call needs a result before the next request, even ones we refuse to run.
        if (calls.length) {
          this.#push({ role: "user", parts: calls.map((c) => result(c, `Not run: the response was cut off (${turn.cutOff!.detail}).`, true)) });
        }
        return;
      }
      if (calls.length === 0) return;

      const results: ToolResult[] = [];
      for (const call of calls) results.push(await this.#runTool(call, signal));
      this.#push({ role: "user", parts: results });
      if (signal?.aborted) return;
    }
  }

  // One request. Its usage is reported even if the reply is then discarded, because it is billed.
  async #request(provider: Provider, signal?: AbortSignal): Promise<Turn | undefined> {
    const { bus, tools, system } = this.opts;
    try {
      const turn = await provider.complete({ system, messages: this.messages, tools: tools.map((t) => t.spec), signal });
      bus.emit("usage", { provider: turn.servedBy ?? provider.id, usage: turn.usage });
      return turn;
    } catch (err) {
      if (!signal?.aborted) bus.emit("error", { kind: "provider", attempted: `request to ${provider.id}`, message: errorText(err), lead: this.#lead.id });
      return undefined;
    }
  }

  async #runTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    if (signal?.aborted) return result(call, "Cancelled by the user.", true);
    const fail = (message: string) => {
      // Capped like the message: a failed write_file's input is the whole file.
      this.opts.bus.emit("error", { kind: "tool", attempted: truncate(`${call.name} ${JSON.stringify(call.input)}`), message, lead: this.#lead.id });
      return result(call, message, true);
    };
    const tool = this.opts.tools.find((t) => t.spec.name === call.name);
    if (!tool) return fail(`Unknown tool: ${call.name}`);
    try {
      return result(call, truncate(await tool.run(call.input, { ...this.opts.ctx, signal })), false);
    } catch (err) {
      if (err instanceof Declined) return result(call, err.message, true);
      if (signal?.aborted) return result(call, "Cancelled by the user.", true); // not a failure, so not logged
      return fail(truncate(errorText(err)));
    }
  }

  #push(message: Message): void {
    this.messages.push(message);
    this.opts.bus.emit("message", message);
  }
}

function result(call: ToolCall, output: string, isError: boolean): ToolResult {
  return { type: "tool_result", callId: call.id, output, isError };
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/core/session.test.ts && npm run typecheck`
Expected: 23 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/core/session.ts tests/core/session.test.ts
git commit -m "feat: agent loop with tool calls, lead switching and error events"
```

### Task 7: Anthropic provider

Converts the neutral format to and from the Messages API. Decisions here, all from the claude-api
skill (2026-10-22):
- **Native replay.** Anthropic's own content is replayed unchanged, so thinking blocks come back
  byte-identical. After a lead switch the API drops blocks the new model can't read, so nothing needs
  stripping.
- **Streaming.** Requests stream, and `finalMessage()` collects the result. This avoids HTTP timeouts at
  the 64,000-token output limit the skill recommends for streamed requests.
- **Caching.** Automatic prompt caching is on (`cache_control` at the top level).
- **Refusal fallback.** `fallbacks: "default"` is on for Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5. A
  refused request is re-run on Anthropic's recommended fallback model instead of failing. When that
  happens, the response carries a `fallback` block, which becomes `turn.fallbacks`. The session then
  shows a notice and logs it (Task 6). For about an hour afterwards Anthropic keeps serving the
  conversation from the fallback model with no block; the signal for that is a `fallback_message`
  entry in `usage.iterations`, which sets `servedBy`, so the reply is priced as the model that answered.
  Whatever the declined model wrote before the last `fallback` block (thinking, half-written tool
  calls) is dropped when the reply arrives: it is never run, answered or sent back. Text is kept.
  Source: claude-api skill, `shared/model-migration.md`, server-side fallback.
  You decided to keep this, with the notice (2026-10-22).
- **Effort.** Only sent when the user passes `--effort`. With no data yet on the right level for this
  harness, the model's own default applies (`medium` on Opus 5.5).

**Files:**
- Create: `src/providers/anthropic.ts`
- Test: `tests/providers/anthropic.test.ts`

**Step 1: Write the failing test**

`tests/providers/anthropic.test.ts`:

```typescript
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Models } from "@anthropic-ai/sdk/resources/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.js";
import { AnthropicProvider, fromAnthropic, toAnthropic } from "../../src/providers/anthropic.js";

// Shaped like a real response; only the fields the adapter reads are filled in.
function message(fields: Partial<BetaMessage>): BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    ...fields,
  } as unknown as BetaMessage;
}

describe("toAnthropic", () => {
  it("converts text, tool calls and tool results", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "call:1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "call:1", output: "boom", isError: true }] },
    ];
    expect(toAnthropic(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }] },
    ]);
  });

  it("replays Anthropic's own content unchanged, thinking blocks included", () => {
    const native = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "hi" }];
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: native } }];
    expect(toAnthropic(history)[0]!.content).toBe(native);
  });

  it("leaves out an assistant message with nothing in it, which the API would reject", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [], native: { provider: "anthropic", content: [] } },
      { role: "assistant", parts: [] },
      // Only the fallback marker survived (the fallback model stopped before writing anything); the
      // API ignores the marker, so this message is empty too.
      { role: "assistant", parts: [], native: { provider: "anthropic", content: [{ type: "fallback", from: { model: "a" }, to: { model: "b" } }] } },
      { role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    expect(toAnthropic(history).map((m) => m.role)).toEqual(["user", "user"]);
  });
});

describe("fromAnthropic", () => {
  it("keeps text and tool calls, and counts cached tokens apart", () => {
    const turn = fromAnthropic(
      message({
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "reading", citations: null },
          { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a" } },
        ] as BetaMessage["content"],
        stop_reason: "tool_use",
      }),
    );
    expect(turn.parts).toEqual([
      { type: "text", text: "reading" },
      { type: "tool_call", id: "tu_1", name: "read_file", input: { path: "a" } },
    ]);
    expect(turn.usage).toEqual({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10 });
    expect(turn.native?.provider).toBe("anthropic");
    expect(turn.cutOff).toBeUndefined();
  });

  it("records when Anthropic's fallback model answered", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [
            { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        } as unknown as BetaMessage["usage"],
        content: [
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } },
          { type: "text", text: "hi", citations: null },
        ] as unknown as BetaMessage["content"],
      }),
    );
    expect(turn.fallbacks).toEqual([{ from: "claude-opus-5-5", to: "claude-opus-4-8" }]);
    expect(turn.servedBy).toBe("anthropic:claude-opus-4-8");
    expect(turn.parts).toEqual([{ type: "text", text: "hi" }]);
  });

  it("names the fallback model on a sticky turn, which carries no fallback block", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi", citations: null }] as BetaMessage["content"],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [{ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null }],
        } as unknown as BetaMessage["usage"],
      }),
    );
    expect(turn.servedBy).toBe("anthropic:claude-opus-4-8");
    expect(turn.fallbacks).toBeUndefined();
  });

  it("drops the declined model's unfinished tool calls and thinking, keeping its text", () => {
    const turn = fromAnthropic(
      message({
        model: "claude-opus-4-8",
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "let me look", citations: null },
          { type: "tool_use", id: "tu_1", name: "shell", input: { command: "rm" } },
          { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: { type: "refusal" } },
          { type: "tool_use", id: "tu_2", name: "read_file", input: { path: "a" } },
        ] as unknown as BetaMessage["content"],
        stop_reason: "tool_use",
      }),
    );
    expect(turn.parts).toEqual([
      { type: "text", text: "let me look" },
      { type: "tool_call", id: "tu_2", name: "read_file", input: { path: "a" } },
    ]);
    expect((turn.native!.content as { type: string }[]).map((b) => b.type)).toEqual(["text", "fallback", "tool_use"]);
    expect(JSON.stringify(turn.native!.content)).not.toContain("tu_1");
  });

  it("reports refusals and hitting a limit", () => {
    const refused = fromAnthropic(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as BetaMessage["stop_details"] }));
    expect(refused.cutOff).toEqual({ kind: "refusal", detail: "The model declined (category: cyber)" });
    expect(fromAnthropic(message({ stop_reason: "max_tokens" })).cutOff?.kind).toBe("max_tokens");
    expect(fromAnthropic(message({ stop_reason: "model_context_window_exceeded" })).cutOff?.kind).toBe("max_tokens");
  });
});

describe("AnthropicProvider.contextWindow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks again after a failed lookup, and remembers a successful one", async () => {
    const retrieve = vi
      .spyOn(Models.prototype, "retrieve")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ max_input_tokens: 1_000 } as never);
    const provider = new AnthropicProvider("claude-opus-5-5");
    expect(await provider.contextWindow()).toBeNull();
    expect(await provider.contextWindow()).toBe(1_000);
    expect(await provider.contextWindow()).toBe(1_000);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/providers/anthropic.test.ts`
Expected: FAIL, cannot find module `../../src/providers/anthropic.js`

**Step 3: Write the code**

`src/providers/anthropic.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CompletionRequest, Message, Part, Provider, Turn } from "../core/types.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// From the claude-api skill (2026-10-22): these models accept the server-side `fallbacks: "default"`
// option, which re-runs a refused request on Anthropic's recommended fallback model.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
// The claude-api skill's default max_tokens for streamed requests.
const MAX_TOKENS = 64_000;

// Tool-call ids from other providers may hold characters Anthropic rejects.
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

function toBlock(p: Part): BetaContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "tool_call":
      return { type: "tool_use", id: safeId(p.id), name: p.name, input: p.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: safeId(p.callId), content: p.output, is_error: p.isError };
  }
}

export function toAnthropic(messages: Message[]): BetaMessageParam[] {
  return (
    messages
      .map((m): BetaMessageParam =>
        m.role === "assistant" && m.native?.provider === "anthropic"
          ? { role: "assistant", content: m.native.content as BetaContentBlockParam[] }
          : { role: m.role, content: m.parts.map(toBlock) },
      )
      // A reply can come back empty (context full before any output), but the API rejects an empty
      // message anywhere but last, and the history is append-only, so it would fail every later request.
      // A `fallback` block alone counts as empty: it is an ignored audit marker.
      .filter((m) => m.role === "user" || (m.content as { type: string }[]).some((b) => b.type !== "fallback"))
  );
}

// After a mid-output fallback, the declined model's unfinished work before the last `fallback` block must
// not be run or echoed back: keep only its text, server-tool calls that got their result, and the markers.
function withoutDeclinedPartial(content: BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.findLastIndex((b) => b.type === "fallback");
  if (boundary < 0) return content;
  const answered = new Set(content.flatMap((b) => ("tool_use_id" in b ? [b.tool_use_id] : [])));
  return content.filter(
    (b, i) =>
      i >= boundary ||
      b.type === "text" ||
      b.type === "fallback" || // kept: the server uses it to tell thinking runs apart on replay
      "tool_use_id" in b ||
      ((b.type === "server_tool_use" || b.type === "mcp_tool_use") && answered.has(b.id)),
  );
}

export function fromAnthropic(msg: BetaMessage): Turn {
  const content = withoutDeclinedPartial(msg.content);
  const parts: Part[] = [];
  const fallbacks: { from: string; to: string }[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    else if (b.type === "fallback") fallbacks.push({ from: b.from.model, to: b.to.model });
  }
  // Covers only the attempt that produced this message: tokens a model spent before declining mid-stream
  // are in usage.iterations alone, so they are not counted here.
  const u = msg.usage;
  const turn: Turn = {
    parts,
    native: { provider: "anthropic", content },
    usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
  // Blocks mark where this turn switched models (for the notice); sticky turns, served by the fallback
  // model with no switch, carry none, so who answered comes from usage.iterations and `model`.
  if (fallbacks.length) turn.fallbacks = fallbacks;
  if (u.iterations?.some((it) => it.type === "fallback_message")) turn.servedBy = `anthropic:${msg.model}`;
  if (msg.stop_reason === "max_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (msg.stop_reason === "model_context_window_exceeded") turn.cutOff = { kind: "max_tokens", detail: "The conversation filled the context window" };
  if (msg.stop_reason === "refusal") turn.cutOff = { kind: "refusal", detail: `The model declined (category: ${msg.stop_details?.category ?? "none given"})` };
  return turn;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  #client = new Anthropic(); // credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile
  #window?: number | null;

  constructor(
    readonly model: string,
    private readonly effort?: Effort,
  ) {
    this.id = `anthropic:${model}`;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    const stream = this.#client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        // No eager_input_streaming: only finalMessage() is read, so streaming tool input early gains
        // nothing here, and it would move input validation from the API to us (claude-api skill, tool-use-concepts.md).
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as BetaTool["input_schema"] })),
        messages: toAnthropic(messages),
        cache_control: { type: "ephemeral" },
        ...(this.effort ? { output_config: { effort: this.effort } } : {}),
        ...(FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal },
    );
    return fromAnthropic(await stream.finalMessage());
  }

  // Only a successful lookup is kept; a failed one (offline, say) is tried again next time.
  async contextWindow(): Promise<number | null> {
    if (this.#window === undefined) {
      try {
        this.#window = (await this.#client.models.retrieve(this.model)).max_input_tokens;
      } catch {
        return null;
      }
    }
    return this.#window;
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/providers/anthropic.test.ts && npm run typecheck`
Expected: 9 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/providers/anthropic.ts tests/providers/anthropic.test.ts
git commit -m "feat: Anthropic provider"
```

### Task 8: OpenAI-format provider

One adapter for OpenAI, OpenRouter, Kimi (Moonshot) and Ollama. All four use chat completions. No
`max_tokens` is sent, so each provider uses its own default; we have no data to pick one. A connection
failure names the address it tried.

**Files:**
- Create: `src/providers/openai.ts`
- Test: `tests/providers/openai.test.ts`

**Step 1: Write the failing test**

`tests/providers/openai.test.ts`:

```typescript
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { Completions } from "openai/resources/chat/completions";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../../src/core/types.js";
import { fromOpenAI, OpenAIProvider, toOpenAI } from "../../src/providers/openai.js";

function completion(message: Record<string, unknown>, finish_reason = "stop", usage?: Record<string, unknown>): ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, finish_reason, logprobs: null, message: { role: "assistant", refusal: null, ...message } }],
    usage: usage ?? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  } as unknown as ChatCompletion;
}

describe("toOpenAI", () => {
  it("puts the system prompt first and tool results right after the call", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "text", text: "looking" }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "nope", isError: true }, { type: "text", text: "and?" }] },
    ];
    expect(toOpenAI("sys", history, "openai")).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: nope" },
      { role: "user", content: "and?" },
    ]);
  });

  it("converts Anthropic turns too, ignoring their native content", () => {
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: [] } }];
    expect(toOpenAI("s", history, "openai")[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("leaves out assistant messages with neither text nor tool calls", () => {
    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [] },
      { role: "user", parts: [{ type: "text", text: "again" }] },
    ];
    expect(toOpenAI("s", history, "openai")).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("fromOpenAI", () => {
  it("parses tool calls and splits out cached tokens", () => {
    const turn = fromOpenAI(
      completion(
        { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        "tool_calls",
        { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } },
      ),
      "openai",
    );
    expect(turn.parts).toEqual([{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }]);
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
    expect(turn.native).toBeUndefined();
  });

  it("passes broken tool arguments on so the schema check rejects them", () => {
    const turn = fromOpenAI(completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{oops" } }] }), "openai");
    expect(turn.parts[0]).toMatchObject({ input: { invalid_json: "{oops" } });
  });

  it("reports hitting the output limit and content filtering", () => {
    expect(fromOpenAI(completion({ content: "par" }, "length"), "openai").cutOff?.kind).toBe("max_tokens");
    expect(fromOpenAI(completion({ content: "" }, "content_filter"), "openai").cutOff?.kind).toBe("refusal");
  });

  it("reports a refusal given in message.refusal", () => {
    const turn = fromOpenAI(completion({ content: null, refusal: "I can't help with that." }), "openai");
    expect(turn.cutOff).toEqual({ kind: "refusal", detail: "I can't help with that." });
  });
});

describe("reasoning fields", () => {
  const call = { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } };

  it("keeps Kimi's reasoning_content and replays it only to Kimi", () => {
    const turn = fromOpenAI(completion({ content: null, reasoning_content: "think first", tool_calls: [call] }, "tool_calls"), "kimi");
    expect(turn.native).toEqual({ provider: "kimi", content: { reasoning_content: "think first" } });

    const history: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: turn.parts, ...(turn.native ? { native: turn.native } : {}) },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "ok", isError: false }] },
    ];
    expect(toOpenAI("s", history, "kimi")[2]).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "think first",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(toOpenAI("s", history, "openai")[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
  });

  it("keeps OpenRouter's reasoning and reasoning_details and nothing else from the raw message", () => {
    const details = [{ type: "reasoning.encrypted", data: "abc" }];
    const turn = fromOpenAI(
      completion({ content: "hi", reasoning: "hmm", reasoning_details: details, annotations: [], audio: null }),
      "openrouter",
    );
    expect(turn.native).toEqual({ provider: "openrouter", content: { reasoning: "hmm", reasoning_details: details } });
  });
});

describe("OpenAIProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects names every object inherits", () => {
    expect(() => new OpenAIProvider("constructor", "m")).toThrow('Unknown OpenAI-format provider "constructor"');
    expect(() => new OpenAIProvider("toString", "m")).toThrow('Unknown OpenAI-format provider "toString"');
  });

  it("reports a timeout as a timeout", async () => {
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionTimeoutError());
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow("http://localhost:11434/v1 did not answer in time");
  });

  it("names the underlying reason a connection failed", async () => {
    // Node's fetch throws "fetch failed" and puts the real reason in its own cause.
    const fetchErr = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionError({ cause: fetchErr }));
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow(
      "Could not reach http://localhost:11434/v1 (connect ECONNREFUSED 127.0.0.1:11434)",
    );
  });

  it("names the reason when it is wrapped in an AggregateError with no message", async () => {
    // What Node 24 throws on Windows for "localhost": one try per address, grouped, with an empty message.
    const tries = [new Error("connect ECONNREFUSED ::1:11434"), new Error("connect ECONNREFUSED 127.0.0.1:11434")];
    const fetchErr = new TypeError("fetch failed", { cause: new AggregateError(tries, "") });
    vi.spyOn(Completions.prototype, "create").mockRejectedValue(new OpenAI.APIConnectionError({ cause: fetchErr }));
    const p = new OpenAIProvider("ollama", "m");
    await expect(p.complete({ system: "s", messages: [], tools: [] })).rejects.toThrow(
      "Could not reach http://localhost:11434/v1 (connect ECONNREFUSED ::1:11434)",
    );
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/providers/openai.test.ts`
Expected: FAIL, cannot find module `../../src/providers/openai.js`

**Step 3: Write the code**

`src/providers/openai.ts`:

```typescript
import OpenAI from "openai";
import type { ChatCompletion, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { CompletionRequest, Message, Part, Provider, Turn } from "../core/types.js";

// Providers that accept OpenAI's chat-completions format. Base URLs checked 2026-10-22 against each
// provider's docs: OpenRouter (openrouter.ai/docs), Moonshot/Kimi global platform (platform.kimi.ai),
// Ollama's OpenAI-compatible endpoint (ollama.com blog).
export const PRESETS: Record<string, { baseURL?: string; keyEnv?: string }> = {
  openai: { keyEnv: "OPENAI_API_KEY" },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  kimi: { baseURL: "https://api.moonshot.ai/v1", keyEnv: "MOONSHOT_API_KEY" },
  ollama: { baseURL: "http://localhost:11434/v1" }, // local; needs no key
};

// Reasoning fields some providers return and need back on later turns: Kimi's `reasoning_content`
// (platform.kimi.ai/docs/guide/use-thinking-models.md, 2026-10-22: tool-call loops fail without it) and
// OpenRouter's `reasoning` / `reasoning_details`. Only these are kept, as OpenAI rejects unknown fields.
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_details"];

export function toOpenAI(system: string, messages: Message[], kind: string): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (m.role === "assistant") {
      const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      // The SDK requires content unless there are tool calls; an empty reply (all output spent on
      // reasoning) stays in the append-only history, so sending it would fail every later request.
      if (!text && !calls.length) continue;
      out.push({
        role: "assistant",
        content: text || null,
        ...(m.native?.provider === kind ? (m.native.content as Record<string, unknown>) : {}),
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
      continue;
    }
    // Tool results must directly follow the assistant message that asked for them.
    for (const p of m.parts) {
      if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.callId, content: p.isError ? `Error: ${p.output}` : p.output });
    }
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { invalid_json: raw }; // fails the tool's schema check, so the model is told
  }
}

export function fromOpenAI(res: ChatCompletion, kind: string): Turn {
  const choice = res.choices[0];
  if (!choice) throw new Error("The provider returned no reply");
  const parts: Part[] = [];
  if (choice.message.content) parts.push({ type: "text", text: choice.message.content });
  for (const c of choice.message.tool_calls ?? []) {
    if (c.type === "function") parts.push({ type: "tool_call", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
  }
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const turn: Turn = {
    parts,
    usage: { input: (res.usage?.prompt_tokens ?? 0) - cached, output: res.usage?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
  };
  // Not in the SDK's type, so read from the raw message; null carries nothing to send back.
  const raw = choice.message as unknown as Record<string, unknown>;
  const reasoning = Object.fromEntries(REASONING_FIELDS.flatMap((f) => (raw[f] != null ? [[f, raw[f]]] : [])));
  if (Object.keys(reasoning).length) turn.native = { provider: kind, content: reasoning };
  if (choice.finish_reason === "length") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (choice.finish_reason === "content_filter") turn.cutOff = { kind: "refusal", detail: "The provider's content filter stopped the response" };
  // OpenAI can decline with the reason in `refusal`, empty content and finish_reason "stop".
  const refusal: unknown = choice.message.refusal;
  if (typeof refusal === "string" && refusal) turn.cutOff = { kind: "refusal", detail: refusal };
  return turn;
}

// Why a connection failed. The SDK's message is only "Connection error."; Node's fetch error ("fetch
// failed") holds the real reason, such as ECONNREFUSED or ENOTFOUND, further down its causes. For
// "localhost" that is an AggregateError with an empty message (one try per address), so its first
// try is used.
function connectReason(err: Error): string {
  let found = err.message;
  for (let e: unknown = err.cause; e instanceof Error; e = e.cause) {
    if (e instanceof AggregateError && e.errors[0] instanceof Error) found = e.errors[0].message;
    else if (e.message) found = e.message;
  }
  return found;
}

export class OpenAIProvider implements Provider {
  readonly id: string;
  #client: OpenAI;

  constructor(
    readonly kind: string,
    readonly model: string,
  ) {
    // hasOwn, so inherited names such as "constructor" are not taken for presets.
    const preset = Object.hasOwn(PRESETS, kind) ? PRESETS[kind] : undefined;
    if (!preset) throw new Error(`Unknown OpenAI-format provider "${kind}"`);
    const apiKey = preset.keyEnv ? process.env[preset.keyEnv] : "ollama"; // the SDK needs some key; Ollama ignores it
    if (!apiKey) throw new Error(`Set ${preset.keyEnv} to use ${kind}`);
    this.#client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.id = `${kind}:${model}`;
  }

  async complete({ system, messages, tools, signal }: CompletionRequest): Promise<Turn> {
    const specs: ChatCompletionTool[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    try {
      const res = await this.#client.chat.completions.create(
        { model: this.model, messages: toOpenAI(system, messages, this.kind), ...(specs.length ? { tools: specs } : {}) },
        { signal },
      );
      return fromOpenAI(res, this.kind);
    } catch (err) {
      // The timeout error is a subclass of the connection error, so it is checked first.
      if (err instanceof OpenAI.APIConnectionTimeoutError) {
        throw new Error(`${this.#client.baseURL} did not answer in time (${err.message}). Check your network, or that the server is running.`);
      }
      if (err instanceof OpenAI.APIConnectionError) {
        throw new Error(`Could not reach ${this.#client.baseURL} (${connectReason(err)}). Check the address, your network, or that the server is running.`);
      }
      throw err;
    }
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/providers/openai.test.ts && npm run typecheck`
Expected: 13 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/providers/openai.ts tests/providers/openai.test.ts
git commit -m "feat: OpenAI-format provider"
```

### Task 9: Provider registry and pricing

`--lead anthropic:claude-opus-5-5` becomes a provider. The pricing table lists only prices copied from a
published source, with its date. Anything else shows as `?`. OpenAI, OpenRouter and Kimi prices are not
in release 1: they need copying from each provider's pricing page with a date, which is a follow-up
task.

**Files:**
- Create: `src/providers/registry.ts`
- Create: `src/providers/pricing.ts`
- Test: `tests/providers/registry.test.ts`

**Step 1: Write the failing test**

`tests/providers/registry.test.ts`:

```typescript
import { afterEach, describe, expect, it, vi } from "vitest";
import { cost } from "../../src/providers/pricing.js";
import { createProvider, parseLead } from "../../src/providers/registry.js";

afterEach(() => vi.unstubAllEnvs());

describe("parseLead", () => {
  it("splits at the first colon only", () => {
    expect(parseLead("anthropic:claude-opus-5-5")).toEqual({ kind: "anthropic", model: "claude-opus-5-5" });
    expect(parseLead("ollama:qwen3:8b")).toEqual({ kind: "ollama", model: "qwen3:8b" });
  });

  it.each(["claude", ":model", "openai:"])("rejects %s", (spec) => {
    expect(() => parseLead(spec)).toThrow("Expected <provider>:<model>");
  });
});

describe("createProvider", () => {
  it("names unknown providers and lists the known ones", () => {
    expect(() => createProvider("acme:x")).toThrow('Unknown provider "acme". Known: anthropic, openai, openrouter, kimi, ollama');
  });

  it("does not mistake names every object has for providers", () => {
    expect(() => createProvider("constructor:x")).toThrow('Unknown provider "constructor"');
  });

  it("says which key is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => createProvider("openrouter:some/model")).toThrow("Set OPENROUTER_API_KEY to use openrouter");
  });

  it("needs no key for Ollama", () => {
    expect(createProvider("ollama:qwen3:8b").id).toBe("ollama:qwen3:8b");
  });
});

describe("cost", () => {
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
  it("prices known models", () => {
    expect(cost("anthropic:claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 0.2 + 5);
  });
  it("counts local models as free and unknown ones as unknown", () => {
    expect(cost("ollama:qwen3:8b", u)).toBe(0);
    expect(cost("openai:some-model", u)).toBeNull();
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/providers/registry.test.ts`
Expected: FAIL, cannot find module `../../src/providers/registry.js`

**Step 3: Write the code**

`src/providers/registry.ts`:

```typescript
import type { Provider } from "../core/types.js";
import { AnthropicProvider, type Effort } from "./anthropic.js";
import { OpenAIProvider, PRESETS } from "./openai.js";

export function parseLead(spec: string): { kind: string; model: string } {
  const i = spec.indexOf(":"); // split at the first colon only: Ollama models look like "qwen3:8b"
  if (i <= 0 || i === spec.length - 1) throw new Error(`Expected <provider>:<model>, e.g. anthropic:claude-opus-5-5 (got "${spec}")`);
  return { kind: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function createProvider(spec: string, opts: { effort?: Effort } = {}): Provider {
  const { kind, model } = parseLead(spec);
  if (kind === "anthropic") return new AnthropicProvider(model, opts.effort);
  if (Object.hasOwn(PRESETS, kind)) return new OpenAIProvider(kind, model); // `in` would accept "constructor"
  throw new Error(`Unknown provider "${kind}". Known: anthropic, ${Object.keys(PRESETS).join(", ")}`);
}
```

`src/providers/pricing.ts`:

```typescript
import type { Usage } from "../core/types.js";

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens, copied 2026-10-22 from the claude-api skill: input, output and cache reads
// from each model's notes in shared/models.md, cache writes 1.25x input for the 5-minute cache
// (shared/prompt-caching.md, "Economics"). Claude Haiku 5.5 is left out because its price changes
// above 100K-token prompts.
// A model missing here shows its cost as "?"; we never guess a price.
export const PRICES: Record<string, Rates> = {
  "anthropic:claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic:claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic:claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function cost(provider: string, u: Usage): number | null {
  if (provider.startsWith("ollama:")) return 0; // runs locally
  const r = PRICES[provider];
  if (!r) return null;
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.cacheRead + u.cacheWrite * r.cacheWrite) / 1_000_000;
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/providers/registry.test.ts && npm run typecheck`
Expected: 10 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/providers/registry.ts src/providers/pricing.ts tests/providers/registry.test.ts
git commit -m "feat: provider registry and pricing table"
```

### Task 10: Error log and running totals

Every error event becomes one JSON line in `.tachikoma/errors.jsonl`. The log is optional (design,
"Safeguards"): if it cannot be written, it says so once and turns itself off, and the session carries on. `Stats` keeps the totals the status line shows.

**Files:**
- Create: `src/core/errorlog.ts`
- Create: `src/core/stats.ts`
- Test: `tests/core/errorlog.test.ts`

**Step 1: Write the failing test**

`tests/core/errorlog.test.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Bus } from "../../src/core/bus.js";
import { attachErrorLog, summarize } from "../../src/core/errorlog.js";
import { Stats } from "../../src/core/stats.js";

describe("error log", () => {
  it("writes one JSON line per error and summarises them", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), ".tachikoma", "errors.jsonl");
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    bus.emit("error", { kind: "tool", attempted: "shell", message: "exit code: 1\nmore", lead: "fake:a" });
    bus.emit("error", { kind: "provider", attempted: "request", message: "429", lead: "fake:a" });

    const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ session: "s1", kind: "tool", attempted: "shell", lead: "fake:a" });
    expect(summarize(file)).toContain("2 errors logged");
    expect(summarize(file)).toContain("  tool: 1");
    expect(summarize(file)).toContain("request\n  429");
  });

  it("keeps its folder out of git, without touching the project's .gitignore", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const bus = new Bus();
    attachErrorLog(bus, path.join(root, ".tachikoma", "errors.jsonl"), "s1");
    bus.emit("error", { kind: "tool", attempted: "write_file secret", message: "x", lead: "fake:a" });
    expect(readFileSync(path.join(root, ".tachikoma", ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("leaves an existing .gitignore in its folder alone", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), ".tachikoma");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".gitignore"), "errors.jsonl\n");
    const bus = new Bus();
    attachErrorLog(bus, path.join(dir, "errors.jsonl"), "s1");
    bus.emit("error", { kind: "tool", attempted: "shell", message: "x", lead: "fake:a" });
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("errors.jsonl\n");
  });

  it("turns itself off, saying so once, when the log cannot be written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-"));
    writeFileSync(path.join(dir, "blocker"), "");
    const file = path.join(dir, "blocker", "errors.jsonl"); // its folder is a file, so writing fails
    const bus = new Bus();
    attachErrorLog(bus, file, "s1");
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    const report = { kind: "tool", attempted: "shell", message: "x", lead: "fake:a" } as const;
    expect(() => bus.emit("error", report)).not.toThrow();
    bus.emit("error", report);
    expect(said).toHaveBeenCalledTimes(1);
    expect(String(said.mock.calls[0]![0])).toContain("Error log turned off");
    said.mockRestore();
  });

  it("says so when there is no log yet", () => {
    expect(summarize(path.join(tmpdir(), "does-not-exist.jsonl"))).toBe("No errors logged yet.");
  });

  const row = (attempted: string) => JSON.stringify({ at: "2026-10-22T00:00:00.000Z", session: "s1", kind: "tool", attempted, message: "it broke", lead: "fake:a" });
  async function logFile(...lines: string[]) {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "errors.jsonl");
    writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  it("skips a half-written line and says how many it skipped", async () => {
    const file = await logFile(row("shell").slice(0, 20), row("shell"));
    const out = summarize(file);
    expect(out).toContain("1 errors logged");
    expect(out).toContain("shell\n  it broke");
    expect(out).toContain("(1 unreadable line skipped)");
  });

  it("skips rows missing fields and null lines", async () => {
    const file = await logFile(JSON.stringify({ kind: "tool", attempted: "shell" }), "null", "5", row("shell"));
    const out = summarize(file);
    expect(out).toContain("1 errors logged");
    expect(out).toContain("(3 unreadable lines skipped)");
  });

  it("skips a last row that has no message", async () => {
    const out = summarize(await logFile(row("shell"), JSON.stringify({ at: "x", kind: "tool", attempted: "shell" })));
    expect(out).toContain("shell\n  it broke");
    expect(out).toContain("(1 unreadable line skipped)");
  });

  it("still reports skipped lines when no row could be read", async () => {
    expect(summarize(await logFile("{"))).toBe("No errors logged yet.\n(1 unreadable line skipped)");
  });

  it("shortens a long attempted action to the terminal width", async () => {
    const file = await logFile(row(`write_file ${"x".repeat(5000)}`));
    const recent = (width?: number) => summarize(file, width).split("\n").find((l) => l.startsWith("Most recent"))!;
    expect(recent(40)).toHaveLength(40);
    expect(recent(40).endsWith("…")).toBe(true);
    expect(recent().length).toBeLessThanOrEqual(process.stdout.columns ?? 80);
  });
});

describe("Stats", () => {
  it("adds up tokens and cost, and flags unknown prices", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } });
    bus.emit("usage", { provider: "openai:unknown", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } });
    expect(stats.cost).toBeCloseTo(4);
    expect(stats.costUnknown).toBe(true);
    expect(stats.input).toBe(1_000_010);
    expect(stats.context).toBe(15);
  });

  it("does not count a rescued refusal as an error", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "a declined; b answered instead", lead: "a" });
    expect(stats.errors).toBe(0);
    expect(stats.fallbacks).toBe(1);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/errorlog.test.ts`
Expected: FAIL, cannot find module `../../src/core/errorlog.js`

**Step 3: Write the code**

`src/core/errorlog.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Bus, ErrorEvent } from "./bus.js";
import { errorText } from "./types.js";

type Row = ErrorEvent & { at: string; session: string };

// One JSON line per failure, in the project's .tachikoma folder, which it keeps out of git.
// The log is optional: if it cannot be written, it says so once and turns itself off.
export function attachErrorLog(bus: Bus, file: string, session: string): void {
  const write = (e: ErrorEvent) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // The log holds failed inputs (whole files, full commands) that may contain secrets.
      const ignore = path.join(path.dirname(file), ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf8");
      const row: Row = { at: new Date().toISOString(), session, ...e };
      appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    } catch (err) {
      bus.off("error", write);
      console.error(`Error log turned off: could not write ${file} (${errorText(err)}).`);
    }
  };
  bus.on("error", write);
}

// Same rule as the scrollback (tui/describe.ts), kept here so core does not import from the interface.
const fit = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

// A killed process or a full disk can leave a half-written line; one bad line must not hide the rest.
function parse(line: string): Row | undefined {
  try {
    const r = JSON.parse(line);
    if (typeof r?.kind === "string" && typeof r.attempted === "string" && typeof r.message === "string") return r;
  } catch {}
  return undefined;
}

export function summarize(file: string, width = process.stdout.columns ?? 80): string {
  if (!existsSync(file)) return "No errors logged yet.";
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const rows = lines.map(parse).filter((r) => r !== undefined);
  const skipped = lines.length - rows.length;
  const note = skipped ? [`(${skipped} unreadable line${skipped === 1 ? "" : "s"} skipped)`] : [];
  if (rows.length === 0) return ["No errors logged yet.", ...note].join("\n");
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const last = rows.at(-1)!;
  return [
    `${rows.length} errors logged in ${file}`,
    ...[...counts].map(([kind, n]) => `  ${kind}: ${n}`),
    // A failed write_file's input is the whole file.
    `${fit(`Most recent (${last.at}): ${last.attempted}`, width)}\n  ${last.message.split("\n")[0]}`,
    ...note,
  ].join("\n");
}
```

`src/core/stats.ts`:

```typescript
import { cost } from "../providers/pricing.js";
import type { Bus } from "./bus.js";

// Running totals for the status line.
export class Stats {
  input = 0; // all prompt tokens sent, cached or not
  output = 0;
  cost = 0; // USD, for calls whose price is known
  costUnknown = false; // true once any call had no known price
  context = 0; // size of the most recent request plus its reply
  errors = 0;
  fallbacks = 0; // refusals another model answered; shown, but not counted as errors

  constructor(bus: Bus) {
    bus.on("usage", ({ provider, usage }) => {
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      this.input += prompt;
      this.output += usage.output;
      this.context = prompt + usage.output;
      const c = cost(provider, usage);
      if (c === null) this.costUnknown = true;
      else this.cost += c;
    });
    bus.on("error", (e) => (e.kind === "fallback" ? this.fallbacks++ : this.errors++));
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/core/errorlog.test.ts && npm run typecheck`
Expected: 12 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/core/errorlog.ts src/core/stats.ts tests/core/errorlog.test.ts
git commit -m "feat: error log and session totals"
```

### Task 11: Status line and scrollback lines

The bar along the bottom, and how each message appears above it.

**Files:**
- Create: `src/tui/StatusLine.tsx`
- Create: `src/tui/describe.ts`
- Test: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing test**

`tests/tui/statusline.test.tsx`:

```tsx
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { describe as describeMessage, screen } from "../../src/tui/describe.js";
import { formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";

const info: StatusInfo = {
  lead: "anthropic:claude-opus-5-5",
  context: 500_000,
  contextWindow: 1_000_000,
  input: 12_345,
  output: 678,
  cost: 0.4213,
  costUnknown: false,
  mode: "ask",
  errors: 2,
};

// Renders once and unmounts, so Ink instances do not pile up.
function frame(i: StatusInfo, segments: Segment[]) {
  const app = render(<StatusLine info={i} segments={segments} />);
  const shown = app.lastFrame();
  app.unmount();
  return shown;
}

describe("StatusLine", () => {
  it("shows every part by default", () => {
    const shown = frame(info, SEGMENTS);
    expect(shown).toContain("lead anthropic:claude-opus-5-5");
    expect(shown).toContain("ctx 50%");
    expect(shown).toContain("12.3k in / 678 out");
    expect(shown).toContain("$0.42");
    expect(shown).toContain("perm ask");
    expect(shown).toContain("2 errors");
  });

  it("shows only the chosen parts, and raw context size when the window is unknown", () => {
    const shown = frame({ ...info, contextWindow: null, costUnknown: true }, ["context", "cost"]);
    expect(shown).toContain("ctx 500.0k");
    expect(shown).toContain("$0.42 + ?");
    expect(shown).not.toContain("lead");
  });

  it.each([
    [999, 1000, "999 in / 1.0k out"],
    [999_999, 1_000_000, "1.0M in / 1.0M out"], // rounds to 1000.0k, so it is shown in millions
    [999_949, 1_000_000, "999.9k in / 1.0M out"],
  ])("counts %d and %d tokens as thousands or millions", (input, output, shown) => {
    expect(formatSegment("tokens", { ...info, input, output })).toBe(shown);
  });

  it("shows a part listed twice without a duplicate-key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(frame(info, ["cost", "cost"])).toContain("$0.42 | $0.42");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("describe", () => {
  it("shows tool calls and failed results on one line each", () => {
    const lines = describeMessage(
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\r\nlots more", isError: true }] },
      80,
    );
    expect(lines.map(screen)).toEqual([{ text: "  ⎿ exit code: 1", color: "red" }]);
  });

  it("does not show an unknown kind of part as a tool result", () => {
    expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] }, 80)).toEqual([]);
  });

  it("cuts a one-line entry to the width after escaping, so escapes count", () => {
    const [line] = describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name: "\u001b\u001b", input: 1 }] }, 10);
    expect(screen(line!).text).toBe("● \\u001b\\…");
  });
});

describe("screen", () => {
  it("keeps line breaks and tabs in prose, and escapes everything else", () => {
    expect(screen({ text: "a\tb\r\nc\rd\n\u001b]52;c;eA==\u0007" }).text).toBe("a\tb\nc␍d\n\\u001b]52;c;eA==\\u0007");
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tui/statusline.test.tsx`
Expected: FAIL, cannot find module `../../src/tui/describe.js`

**Step 3: Write the code**

`src/tui/StatusLine.tsx`:

```tsx
import { Box, Text } from "ink";

export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors";
export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors"];

export interface StatusInfo {
  lead: string;
  context: number;
  contextWindow: number | null;
  input: number;
  output: number;
  cost: number;
  costUnknown: boolean;
  mode: string;
  errors: number;
}

// The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
const k = (n: number) => {
  if (n < 1000) return String(n);
  const thousands = (n / 1000).toFixed(1);
  return Number(thousands) < 1000 ? `${thousands}k` : `${(n / 1_000_000).toFixed(1)}M`;
};

export function formatSegment(s: Segment, i: StatusInfo): string {
  switch (s) {
    case "lead":
      return `lead ${i.lead}`;
    case "context":
      return i.contextWindow ? `ctx ${Math.round((100 * i.context) / i.contextWindow)}%` : `ctx ${k(i.context)}`;
    case "tokens":
      return `${k(i.input)} in / ${k(i.output)} out`;
    case "cost":
      return `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
    case "mode":
      return `perm ${i.mode}`;
    case "errors":
      return `${i.errors} errors`;
  }
}

export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
  return (
    <Box>
      {segments.map((s, n) => (
        <Text key={n} inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
          {n === 0 ? " " : " | "}
          {formatSegment(s, info)}
          {n === segments.length - 1 ? " " : ""}
        </Text>
      ))}
    </Box>
  );
}
```

`src/tui/describe.ts`:

```typescript
import { visible } from "../core/permissions.js";
import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
  width?: number; // set for one-line entries: cut to this width once escaped
}

const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
const fit = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

// Every scrollback line passes through here. Model and provider text can carry escape codes (OSC 52
// writes the clipboard), \r and bidi overrides, which the terminal would act on. Prose keeps its line
// breaks and tabs; one-line entries are cut after escaping, so the escapes count toward the width.
export function screen(l: Line): Line {
  const text = l.width === undefined ? l.text.split(/\r?\n/).map((s) => visible(s, { tabs: true })).join("\n") : fit(visible(l.text), l.width);
  return l.color === undefined ? { text } : { text, color: l.color };
}

// How one message appears in the scrollback.
export function describe(m: Message, width = process.stdout.columns ?? 80): Line[] {
  const lines: Line[] = [];
  for (const p of m.parts) {
    if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${JSON.stringify(p.input)}`, color: "yellow", width });
    else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", width });
    else {
      const _: never = p; // a new kind of part must be given its own line here
    }
  }
  return lines;
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/tui/statusline.test.tsx && npm run typecheck`
Expected: 10 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/tui/StatusLine.tsx src/tui/describe.ts tests/tui/statusline.test.tsx
git commit -m "feat: status line"
```

### Task 12: Interactive screen

Ink renders the scrollback, the input line, permission prompts and the status line. The input line is
hand-written with `useInput`; `ink-text-input` was skipped because its last release (2024) predates Ink 7.
Ctrl-C stops the current turn, or quits when idle.

**Files:**
- Create: `src/tui/App.tsx`
- Test: `tests/tui/app.test.tsx`

**Step 1: Write the failing test**

`tests/tui/app.test.tsx`:

```tsx
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
import type { Provider } from "../../src/core/types.js";
import { TOOLS } from "../../src/tools/index.js";
import { App } from "../../src/tui/App.js";
import { SEGMENTS } from "../../src/tui/StatusLine.js";
import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";

const tick = () => new Promise((r) => setTimeout(r, 50));

// Wait until the screen shows `text`; the session runs real file I/O in the background.
async function until(app: ReturnType<typeof render>, text: string) {
  for (let i = 0; i < 40 && !app.lastFrame()?.includes(text); i++) await tick();
  expect(app.lastFrame()).toContain(text);
}

const mounted: ReturnType<typeof render>[] = [];
afterEach(() => {
  for (const app of mounted.splice(0)) app.unmount();
});

async function mount(turns: ConstructorParameters<typeof FakeProvider>[1], opts: { lead?: Provider; errorFile?: string } = {}) {
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  let ask: (s: string) => Promise<boolean> = async () => false;
  const gate = new PermissionGate("ask", (s) => ask(s));
  const lead = opts.lead ?? new FakeProvider("a", turns);
  const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
  const app = render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode="ask"
      errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
      segments={SEGMENTS}
      makeProvider={() => new FakeProvider("b", [])}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
  );
  mounted.push(app);
  await tick();
  return { app, session, ctx, bus, ask: (s: string) => ask(s) };
}

async function type(app: ReturnType<typeof render>, text: string) {
  app.stdin.write(text);
  await tick();
  app.stdin.write("\r");
  await tick();
}

// A lead whose request never finishes until it is cancelled.
const hanging = (): Provider => ({
  id: "fake:hang",
  complete: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
});

// What a model or provider might send to rewrite the clipboard (OSC 52), hide text, overwrite a line
// or reverse it.
const OSC52 = "\u001b]52;c;Y3VybA==\u0007";
const OSC52_SHOWN = "\\u001b]52;c;Y3VybA==\\u0007";

function expectNoRawControls(frame: string | undefined) {
  for (const c of ["\u001b", "\u0007", "\r", "‮", "\u009b"]) expect(frame).not.toContain(c);
}

describe("App", () => {
  it("sends what the user types and shows the reply", async () => {
    const { app } = await mount([reply("hello there")]);
    await type(app, "hi");
    expect(app.lastFrame()).toContain("> hi");
    await until(app, "hello there");
    expect(app.lastFrame()).toContain("lead fake:a");
  });

  it("asks before a write and goes ahead on y", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}? [y/n]`);
    app.stdin.write("y");
    await until(app, "written");
  });

  it("on Ctrl-C at an approval prompt, says no, stops the turn and gives the input line back", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n]`);
    app.stdin.write("\u0003");
    await until(app, `write ${target}: declined (cancelled)`);
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("working");
    expect(app.lastFrame()).not.toContain("[y/n]");
    expect(app.lastFrame()).not.toContain("written");
    expect(existsSync(target)).toBe(false);
  });

  it("says no at once, without a prompt, when asked after the turn was cancelled", async () => {
    const { app, ask } = await mount([], { lead: hanging() });
    await type(app, "hi");
    await until(app, "working");
    app.stdin.write("\u0003");
    await until(app, "›");
    expect(app.lastFrame()).not.toContain("working");
    const answer = await Promise.race([ask("write x"), tick().then(() => "still waiting")]);
    expect(answer).toBe(false);
    expect(app.lastFrame()).not.toContain("[y/n]");
  });

  it("counts only the first of two answers typed together", async () => {
    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
    await type(app, "make a file");
    const target = path.join(ctx.root, "a.txt");
    await until(app, `Allow write ${target}? [y/n]`);
    // Two key events before the screen redraws; one chunk "yn" would arrive as a single input.
    app.stdin.write("y");
    app.stdin.write("n");
    await until(app, "written");
    expect(app.lastFrame()).toContain(`write ${target}: allowed`);
    expect(app.lastFrame()).not.toContain("declined");
  });

  it("switches the lead with /lead", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead fake:b");
    expect(session.lead.id).toBe("fake:b");
    expect(app.lastFrame()).toContain("lead is now fake:b");
  });

  it("shows how to use /lead, and does not send it to the model", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead");
    expect(app.lastFrame()).toContain("Usage: /lead <provider:model>");
    expect(session.messages).toEqual([]);
  });

  it("refuses an unknown command instead of sending it to the model", async () => {
    const { app, session } = await mount([]);
    await type(app, "/eror");
    expect(app.lastFrame()).toContain("Unknown command: /eror");
    expect(app.lastFrame()).toContain("/errors");
    expect(session.messages).toEqual([]);
  });

  it("sends a message that only starts with a path", async () => {
    const { app, session } = await mount([reply("ok")]);
    await type(app, "/usr/bin is missing");
    await until(app, "ok");
    expect(session.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "/usr/bin is missing" }] });
  });

  it("ignores a context-window lookup that finishes after the lead changed", async () => {
    let finish: (n: number) => void = () => {};
    const slow = Object.assign(new FakeProvider("a", []), { contextWindow: () => new Promise<number>((r) => (finish = r)) });
    const { app } = await mount([], { lead: slow });
    await type(app, "/lead fake:b");
    finish(1000);
    await tick();
    expect(app.lastFrame()).toContain("lead fake:b");
    expect(app.lastFrame()).toContain("ctx 0 ");
    expect(app.lastFrame()).not.toContain("ctx 0%");
  });

  it("keeps going when the context-window lookup fails", async () => {
    const broken = Object.assign(new FakeProvider("a", [reply("still here")]), { contextWindow: () => Promise.reject(new Error("no window")) });
    const { app } = await mount([], { lead: broken });
    await type(app, "hi");
    await until(app, "still here");
    expect(app.lastFrame()).toContain("ctx 15 "); // the window stays unknown, so the raw size is shown
  });

  it("shows when another model answered a refused turn", async () => {
    const { app, bus } = await mount([]);
    bus.emit("error", { kind: "fallback", attempted: "x", message: "fake:a declined; fake:b answered instead", lead: "fake:a" });
    await until(app, "↪ fake:a declined; fake:b answered instead");
    expect(app.lastFrame()).toContain("0 errors");
  });

  it("summarises the error log with /errors", async () => {
    const { app } = await mount([]);
    await type(app, "/errors");
    expect(app.lastFrame()).toContain("No errors logged yet.");
  });

  it("shows an error, and keeps running, when the error log cannot be read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-"));
    const { app } = await mount([reply("still here")], { errorFile: dir });
    await type(app, "/errors");
    await until(app, "EISDIR");
    await type(app, "hi");
    await until(app, "still here");
  });

  it("shows control characters in a reply as escapes, keeping real line breaks", async () => {
    const { app } = await mount([reply(`one${OSC52}\u001b[8mhidden\rover‮back\ntwo`)]);
    await type(app, "hi");
    await until(app, "two");
    const frame = app.lastFrame();
    expect(frame).toContain(`one${OSC52_SHOWN}\\u001b[8mhidden␍over\\u202eback\n`);
    expectNoRawControls(frame);
  });

  it("shows control characters in a tool call's name and input, and in its error, as escapes", async () => {
    const { app } = await mount([callTool("c1", `x${OSC52}\r`, { s: "‮\u009b" }), reply("done")]);
    await type(app, "hi");
    await until(app, "done");
    const frame = app.lastFrame();
    expect(frame).toContain(`● x${OSC52_SHOWN}␍ {"s":"\\u202e\\u009b"}`);
    expect(frame).toContain(`⎿ Unknown tool: x${OSC52_SHOWN}␍`);
    expectNoRawControls(frame);
  });

  it("shows control characters in the user's line and in provider errors as escapes", async () => {
    const { app, bus } = await mount([]);
    bus.emit("message", { role: "user", parts: [{ type: "text", text: "a\u001b[8mb\rc" }] });
    bus.emit("error", { kind: "provider", attempted: "x", message: `bad${OSC52}`, lead: "fake:a" });
    await until(app, "✗ provider");
    const frame = app.lastFrame();
    expect(frame).toContain("> a\\u001b[8mb␍c");
    expect(frame).toContain(`✗ provider: bad${OSC52_SHOWN}`);
    expectNoRawControls(frame);
  });
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/tui/app.test.tsx`
Expected: FAIL, cannot find module `../../src/tui/App.js`

**Step 3: Write the code**

`src/tui/App.tsx`:

```tsx
import { Static, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Bus, ErrorEvent } from "../core/bus.js";
import { summarize } from "../core/errorlog.js";
import type { Mode } from "../core/permissions.js";
import type { Session } from "../core/session.js";
import type { Stats } from "../core/stats.js";
import { errorText, type Message, type Provider } from "../core/types.js";
import { describe, type Line, screen } from "./describe.js";
import { type Segment, StatusLine } from "./StatusLine.js";

type Question = { text: string; answer: (ok: boolean, how: string) => void };

export interface AppProps {
  session: Session;
  bus: Bus;
  stats: Stats;
  mode: Mode;
  errorFile: string;
  segments: Segment[];
  makeProvider: (spec: string) => Provider;
  bindAsk: (ask: (summary: string) => Promise<boolean>) => void;
}

export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk }: AppProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<(Line & { id: number })[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);

  // A late answer for the previous lead must not show as the new lead's window.
  const lookUpWindow = () => {
    const lead = session.lead;
    setContextWindow(null);
    lead.contextWindow?.()
      .then((n) => session.lead === lead && setContextWindow(n))
      .catch(() => {}); // stays unknown
  };

  useEffect(() => {
    bindAsk((text) => {
      // A tool still finishing after Ctrl-C must not ask about a turn the user has stopped.
      if (abort.current?.signal.aborted) return Promise.resolve(false);
      return new Promise((resolve) => {
        let open = true; // answered once: two keys arriving together would otherwise both be logged
        setQuestion({
          text,
          answer: (ok, how) => {
            if (!open) return;
            open = false;
            say({ text: `${text}: ${how}`, color: "gray" });
            resolve(ok);
            setQuestion(null);
          },
        });
      });
    });
    const onMessage = (m: Message) => say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") rerender((n) => n + 1);
      else if (e.kind === "fallback") say({ text: `↪ ${e.message}`, color: "magenta" });
      else say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => rerender((n) => n + 1);
    const onLead = (id: string) => {
      say({ text: `lead is now ${id}`, color: "magenta" });
      lookUpWindow();
    };
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
    lookUpWindow();
    return () => {
      bus.off("message", onMessage);
      bus.off("error", onError);
      bus.off("usage", onUsage);
      bus.off("lead", onLead);
    };
  }, []);

  // Called without await, so nothing may escape: an unhandled rejection ends the program.
  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    try {
      if (text === "/exit") return exit();
      if (text === "/errors") return say({ text: summarize(errorFile) });
      if (text === "/lead") return say({ text: "Usage: /lead <provider:model>" });
      if (text.startsWith("/lead ")) return session.setLead(makeProvider(text.slice("/lead ".length).trim()));
      // A mistyped command must not become a paid turn.
      // A slash and a bare word is a command; "/usr/bin is missing" is a message.
      if (/^\/[a-z]+$/i.test(text.split(/\s/)[0]!)) return say({ text: `Unknown command: ${text}. Commands: /lead <provider:model>, /errors, /exit`, color: "red" });
      abort.current = new AbortController();
      setBusy(true);
      try {
        await session.send(text, abort.current.signal);
      } finally {
        setBusy(false);
      }
    } catch (err) {
      say({ text: errorText(err), color: "red" });
    }
  };

  useInput((ch, key) => {
    if (question) {
      if (key.ctrl && ch === "c") {
        question.answer(false, "declined (cancelled)");
        abort.current?.abort();
      } else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
      return;
    }
    if (key.ctrl && ch === "c") return busy ? abort.current?.abort() : exit();
    if (busy) return;
    if (key.return) {
      void submit(input);
      setInput("");
    } else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
    else if (!key.ctrl && !key.meta && ch) setInput((s) => s + ch);
  });

  return (
    <>
      <Static items={lines}>
        {(l) => (
          <Text key={l.id} color={l.color}>
            {l.text}
          </Text>
        )}
      </Static>
      {question ? (
        <Text color="yellow">Allow {question.text}? [y/n]</Text>
      ) : (
        <Text>{busy ? "… working (Ctrl-C to stop)" : `› ${input}`}</Text>
      )}
      <StatusLine
        segments={segments}
        info={{
          lead: session.lead.id,
          context: stats.context,
          contextWindow,
          input: stats.input,
          output: stats.output,
          cost: stats.cost,
          costUnknown: stats.costUnknown,
          mode,
          errors: stats.errors,
        }}
      />
    </>
  );
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/tui/app.test.tsx && npm run typecheck`
Expected: 17 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/tui/App.tsx tests/tui/app.test.tsx
git commit -m "feat: interactive screen"
```

### Task 13: Command-line entry point

**Files:**
- Create: `src/core/prompt.ts`, `src/clilib.ts`, `src/cli.tsx`
- Test: `tests/clilib.test.ts`, `tests/cli.test.ts`

**Step 1: Write the code**

`src/core/prompt.ts`:

```typescript
import { shellFor } from "../exec/local.js";

// Built once per session and never changed after (see SessionOptions.system).
export function systemPrompt(root: string, platform: NodeJS.Platform = process.platform): string {
  return [
    "You are Tachikoma, a coding agent working in the user's terminal.",
    `The project root is ${root}. File paths are relative to it.`,
    // powershell.exe is 5.1, which has no && or ||; models often assume a newer PowerShell or bash.
    platform === "win32"
      ? "Shell commands run with Windows PowerShell 5.1 on Windows: chain commands with ;, not && or ||."
      : `Shell commands run with ${shellFor(platform).name} on ${platform}.`,
    "Commands get no input and have no time limit, so do not start servers, watchers or anything interactive: it would never return.",
    "Call tools directly. Tachikoma asks the user before risky actions and tells you if they decline; do not retry a declined action another way.",
    "Read files before changing them, prefer edit_file to rewriting whole files, and say plainly when something failed.",
  ].join("\n");
}
```

`src/clilib.ts`:

```typescript
import { constants } from "node:os";
import { type Segment, SEGMENTS } from "./tui/StatusLine.js";

// Stopped wins: an aborted request reports no error, and the shell reads 128 + n as "stopped by signal n".
// A declined action fails the run, or a script would take a run that did nothing for success.
export function headlessExit(run: { aborted: boolean; failed: boolean; declined: boolean }): number {
  if (run.aborted) return 128 + constants.signals.SIGINT;
  return run.failed || run.declined ? 1 : 0;
}

// A segment named twice is shown once, where it first appears.
export function statusSegments(value: string | undefined): Segment[] {
  if (value === undefined) return SEGMENTS;
  const names = value.split(",").map((s) => {
    const name = s.trim();
    if (!(SEGMENTS as string[]).includes(name)) throw new Error(`--status must be one of: ${SEGMENTS.join(", ")} (got "${name}")`);
    return name as Segment;
  });
  return [...new Set(names)];
}

// A reader such as `head` that stops early is a normal end, not a crash.
export function endOnEpipe(err: NodeJS.ErrnoException): void {
  if (err.code !== "EPIPE") throw err;
  process.exit();
}
```

`src/cli.tsx`:

```tsx
#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { render } from "ink";
import { endOnEpipe, headlessExit, statusSegments } from "./clilib.js";
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

process.stdout.on("error", endOnEpipe);

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
let ask: (summary: string) => Promise<boolean> = async (summary) => {
  declined = true;
  console.error(
    `declined, nobody to ask in -p mode (--mode project allows writes inside the project, but shell commands and anything outside it are still refused; --mode never means no checks at all): ${summary}`,
  );
  return false;
};
const gate = new PermissionGate(mode, (summary) => ask(summary));
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
      bus.on(event, (data: unknown) => console.log(JSON.stringify({ event, data })));
    }
  } else {
    bus.on("error", (e) => {
      if (e.kind === "fallback") console.error(`note: ${e.message}`);
      else if (e.kind !== "tool") console.error(`${e.kind}: ${e.message}`);
    });
  }
  // On macOS and Linux the running command is in its own process group, so Ctrl-C reaches only us.
  // A second Ctrl-C gets Node's default and ends at once.
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  await session.send(parsed.print, stop.signal);
  if (!parsed.json) {
    const last = session.messages.at(-1);
    if (last?.role === "assistant") console.log(last.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"));
  }
  process.exitCode = headlessExit({ aborted: stop.signal.aborted, failed, declined });
} else {
  if (!process.stdin.isTTY) fail('Interactive mode needs a terminal; use -p "<prompt>" to run one prompt.');
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
```

The command's own tests: the headless exit code, `--status` parsing, a broken pipe on stdout, and two
runs of the command itself that stop before any model call.

`tests/clilib.test.ts`:

```typescript
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { headlessExit, statusSegments } from "../src/clilib.js";
import { SEGMENTS } from "../src/tui/StatusLine.js";

describe("headlessExit", () => {
  const run = { aborted: false, failed: false, declined: false };

  it("is 0 when the run finished cleanly", () => {
    expect(headlessExit(run)).toBe(0);
  });

  it("is 1 when a turn failed", () => {
    expect(headlessExit({ ...run, failed: true })).toBe(1);
  });

  it("is 1 when an action was declined, so a script does not take it for success", () => {
    expect(headlessExit({ ...run, declined: true })).toBe(1);
  });

  it("is 128 + SIGINT when stopped, whatever else happened", () => {
    expect(headlessExit({ aborted: true, failed: true, declined: true })).toBe(128 + constants.signals.SIGINT);
  });
});

describe("statusSegments", () => {
  it("shows every segment when none are given", () => {
    expect(statusSegments(undefined)).toEqual(SEGMENTS);
  });

  it("keeps the first of repeated segments", () => {
    expect(statusSegments("cost, lead,cost,lead")).toEqual(["cost", "lead"]);
  });

  it("names --status when a segment is unknown", () => {
    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors (got "nope")');
  });
});

describe("endOnEpipe", () => {
  it("ends quietly when the reader of its output stops early", async () => {
    // A real pipe: a single large write fails with EPIPE once the reader has gone.
    const script = `import { endOnEpipe } from "./src/clilib.ts"; process.stdout.on("error", endOnEpipe); process.stdout.write("x\\n".repeat(1e6));`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  });
});
```

`tests/cli.test.ts`:

```typescript
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real command through tsx. Every case here stops before any model is called.
function tachi(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.tsx"), ...args], { input: "x\n", encoding: "utf8", env: { ...process.env, TACHI_LEAD: "" } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("tachi", () => {
  it("names --fallback when its value is bad", () => {
    const r = tachi("--lead", "ollama:none", "--fallback", "nope", "-p", "hi");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^--fallback: /);
  });

  it("refuses interactive mode without a terminal, before starting the interface", () => {
    const r = tachi("--lead", "ollama:none");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Interactive mode needs a terminal; use -p");
    expect(r.stderr).not.toContain("    at "); // no stack trace
  });
});
```

**Step 2: Build and run the whole suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: `Tests  157 passed`, then a `dist/` folder holding `cli.js`.

**Step 3: Smoke-test the command without any API key**

```bash
node dist/cli.js --help            # prints the help, exit 0
node dist/cli.js                   # "No lead model given. Pass --lead or set TACHI_LEAD." exit 1
node dist/cli.js --lead acme:x     # 'Unknown provider "acme". Known: anthropic, openai, openrouter, kimi, ollama' exit 1
node dist/cli.js --lead ollama:qwen3 --mode yolo    # "--mode must be one of: ask, project, never" exit 1
node dist/cli.js --lead ollama:none -p hi           # with no Ollama running: "provider: Could not reach http://localhost:11434/v1 (connect ECONNREFUSED ::1:11434) ..." exit 1
cat .tachikoma/errors.jsonl        # one line for the failed request
```

All five gave exactly this output in the scratch build on 2026-10-22.

**Step 4: Commit**

```bash
git add src/core/prompt.ts src/clilib.ts src/cli.tsx tests/clilib.test.ts tests/cli.test.ts
git commit -m "feat: tachi command, interactive and headless"
```

### Task 14: Live test, README and licence

**Files:**
- Create: `tests/live/providers.live.test.ts`, `README.md`, `LICENSE`
- Modify: `package.json` (add `"license"`)

**Step 1: Write the live test**

It is skipped unless `TACHI_LIVE=1`, so `npm test` stays free.

`tests/live/providers.live.test.ts`:

```typescript
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Session } from "../../src/core/session.js";
import { createProvider } from "../../src/providers/registry.js";
import { TOOLS } from "../../src/tools/index.js";
import { Bus, collectErrors, tempContext, texts } from "../helpers.js";

// Calls real APIs and costs real money, so it runs only with TACHI_LIVE=1, for example:
//   TACHI_LIVE=1 TACHI_LIVE_LEADS=anthropic:claude-opus-5-5,openai:<model> npm test -- tests/live
const leads = (process.env.TACHI_LIVE_LEADS ?? "").split(",").filter(Boolean);

describe.skipIf(!process.env.TACHI_LIVE || leads.length === 0)("live providers", () => {
  it.each(leads)("%s reads a file with a tool and reports what it says", async (spec) => {
    const ctx = await tempContext("never");
    await writeFile(path.join(ctx.root, "secret.txt"), "the word is pelican", "utf8");
    const bus = new Bus();
    const errors = collectErrors(bus);
    const session = new Session({ lead: createProvider(spec), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
    await session.send("Read secret.txt and tell me the word in it.");
    expect(errors).toEqual([]);
    expect(texts(session.messages.at(-1)!).join(" ").toLowerCase()).toContain("pelican");
  }, 120_000);

  it("keeps working when the lead changes mid-conversation", async () => {
    if (leads.length < 2) return;
    const ctx = await tempContext("never");
    const bus = new Bus();
    const session = new Session({ lead: createProvider(leads[0]!), tools: TOOLS, system: "You are a test assistant.", ctx, bus });
    await session.send("Remember this number: 7341. Just say ok.");
    session.setLead(createProvider(leads[1]!));
    await session.send("What number did I ask you to remember?");
    expect(texts(session.messages.at(-1)!).join(" ")).toContain("7341");
  }, 120_000);
});
```

**Step 2: Check it is skipped by default**

Run: `npm test`
Expected: `Tests  157 passed | 1 skipped`.

**Step 3: Run it for real (costs money, needs your key)**

There was no API key or local model on the build machine on 2026-10-22, so this step has not been run
yet. With `ANTHROPIC_API_KEY` set:

```bash
TACHI_LIVE=1 TACHI_LIVE_LEADS=anthropic:claude-opus-5-5 npx vitest run tests/live
```

Expected: 1 passed. A second lead in `TACHI_LIVE_LEADS` (comma-separated) also runs the lead-switch test.

**Step 4: README and licence**

The README has: what Tachikoma is (first paragraph of the design), how to run release 1 from source
(`npm install`, `npm run build`, `node dist/cli.js --lead <provider:model>`), the environment variable
each provider needs, and what is not built yet (the release order from the design). `LICENSE` is the standard MIT text
(opensource.org/license/mit) with the copyright line `Copyright (c) 2026 <name>`. Add
`"license": "MIT"` to `package.json`.

**Step 5: Commit**

```bash
git add tests/live/providers.live.test.ts README.md LICENSE package.json
git commit -m "docs: README, licence and live provider test"
```
