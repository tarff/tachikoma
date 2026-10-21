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

Types only, so there is nothing to test yet. The typecheck is the check.

**Files:**
- Create: `src/core/types.ts`, `src/core/bus.ts`

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
export class Bus extends EventEmitter<Events> {}
```

**Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit code 0.

**Step 3: Commit**

```bash
git add src/core/types.ts src/core/bus.ts
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
import { type Action, Declined, needsApproval, PermissionGate } from "../../src/core/permissions.js";

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
    ["never", act("shell"), false],
    ["never", act("write", true), false],
  ] as const)("%s mode, %o -> %s", (mode, action, expected) => {
    expect(needsApproval(mode, action)).toBe(expected);
  });
});

describe("PermissionGate", () => {
  it("throws Declined when the user says no", async () => {
    const gate = new PermissionGate("ask", async () => false);
    await expect(gate.require(act("write"))).rejects.toBeInstanceOf(Declined);
  });

  it("does not ask when no approval is needed", async () => {
    let asked = false;
    const gate = new PermissionGate("ask", async () => (asked = true));
    await gate.require(act("read"));
    expect(asked).toBe(false);
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

// Thrown when the user says no. The model is told; it is not logged as an error.
export class Declined extends Error {}

export class PermissionGate {
  constructor(
    readonly mode: Mode,
    private readonly ask: (summary: string) => Promise<boolean>,
  ) {}

  async require(action: Action): Promise<void> {
    if (needsApproval(this.mode, action) && !(await this.ask(action.summary))) {
      throw new Declined(`The user declined: ${action.summary}`);
    }
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/core/permissions.test.ts && npm run typecheck`
Expected: 12 tests pass, and no type errors.

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
import { describe, expect, it } from "vitest";
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

describe("LocalExecutor", () => {
  it("cancelling a command also stops the programs it started", async () => {
    const { root } = await tempContext();
    // A grandchild: the shell starts node, which records its pid and waits.
    await writeFile(path.join(root, "child.js"), `require("fs").writeFileSync("pid", String(process.pid)); setTimeout(() => {}, 60000);`);
    const abort = new AbortController();
    const run = new LocalExecutor().exec("node child.js", root, abort.signal);
    const pidFile = path.join(root, "pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);

    abort.abort();
    await expect(run).rejects.toThrow("Cancelled");
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
```

**Step 2: Run it and watch it fail**

Run: `npx vitest run tests/exec/local.test.ts`
Expected: FAIL, cannot find module `../../src/exec/local.js`

**Step 3: Write the code**

`src/exec/executor.ts`:

```typescript
export interface ExecResult {
  code: number | null;
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
import type { ExecResult, Executor } from "./executor.js";

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
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-child.pid, "SIGKILL"); // the shell leads its own process group (detached below)
}

export class LocalExecutor implements Executor {
  exec(command: string, cwd: string, signal?: AbortSignal): Promise<ExecResult> {
    if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
    const [file, ...args] = shellFor().argv(command);
    return new Promise((resolve, reject) => {
      const child = spawn(file!, args, { cwd, windowsHide: true, detached: process.platform !== "win32" });
      let stdout = "";
      let stderr = "";
      const onAbort = () => killTree(child);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(new Error("Cancelled"));
        else resolve({ code, stdout, stderr });
      });
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
export function defineTool<S extends z.ZodType>(
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
Expected: 1 test passes, and no type errors. On Windows this kills the tree with `taskkill /T`. On macOS
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
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
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
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "./tool.js";

// Where a path really leads, following symlinks and Windows junctions. Parts that don't exist yet
// (a new file in a new folder) are added back onto the deepest part that does.
function realTarget(abs: string): string {
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
}

export function resolveIn(root: string, p: string): { abs: string; outside: boolean } {
  const abs = path.resolve(root, p);
  const rel = path.relative(realTarget(root), realTarget(abs));
  // On Windows a path on another drive comes back absolute.
  return { abs, outside: rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) };
}

export const readFileTool = defineTool(
  "read_file",
  "Read a text file. Paths are relative to the project root.",
  z.object({ path: z.string() }),
  async ({ path: p }, ctx) => {
    const { abs, outside } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "read", outside, summary: `read ${abs}` });
    return ctx.executor.readFile(abs);
  },
);

export const writeFileTool = defineTool(
  "write_file",
  "Create or overwrite a text file. Paths are relative to the project root.",
  z.object({ path: z.string(), content: z.string() }),
  async ({ path: p, content }, ctx) => {
    const { abs, outside } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "write", outside, summary: `write ${abs}` });
    await ctx.executor.writeFile(abs, content);
    return `Wrote ${content.length} characters to ${p}`;
  },
);

export const editFileTool = defineTool(
  "edit_file",
  "Replace one exact, unique piece of text in a file. Read the file first.",
  z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
  async ({ path: p, old_text, new_text }, ctx) => {
    const { abs, outside } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "write", outside, summary: `edit ${abs}` });
    const text = await ctx.executor.readFile(abs);
    const count = text.split(old_text).length - 1;
    if (count === 0) throw new Error(`old_text was not found in ${p}`);
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
Expected: 9 tests pass, and no type errors.

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
    const out = `exit code: ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
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
Expected: 3 tests pass, and no type errors.

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
import { MAX_TOOL_OUTPUT, Session } from "../../src/core/session.js";
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
    expect(errors.map((e) => e.kind)).toEqual(["refusal", "fallback"]);
    expect(errors[1]!.message).toBe("fake:a declined; fake:b answered instead");
    expect(seen).toEqual(["fake:a", "fake:b"]); // the refused attempt is billed too
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
import type { Tool, ToolContext } from "../tools/tool.js";
import type { Bus } from "./bus.js";
import { Declined } from "./permissions.js";
import { errorText, type Message, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";

// Claude Code's Bash tool cuts output at 30,000 characters. We start from the same cap until our
// own error log and transcripts show whether it should move.
export const MAX_TOOL_OUTPUT = 30_000;

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
    const { bus } = this.opts;
    this.#push({ role: "user", parts: [{ type: "text", text }] });

    for (;;) {
      const lead = this.#lead;
      let answeredBy = lead;
      let turn = await this.#request(lead, signal);
      if (!turn) return;
      for (const f of turn.fallbacks ?? []) {
        bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${f.from} declined; ${f.to} answered instead (Anthropic's fallback)`, lead: lead.id });
      }
      const rescue = this.opts.fallback;
      if (turn.cutOff?.kind === "refusal" && rescue) {
        // The refused reply is discarded, never stored, so the history stays append-only.
        bus.emit("error", { kind: "refusal", attempted: `response from ${lead.id}`, message: turn.cutOff.detail, lead: lead.id });
        answeredBy = rescue;
        turn = await this.#request(rescue, signal);
        if (!turn) return;
        if (!turn.cutOff) bus.emit("error", { kind: "fallback", attempted: `response from ${lead.id}`, message: `${lead.id} declined; ${rescue.id} answered instead`, lead: lead.id });
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
      this.opts.bus.emit("error", { kind: "tool", attempted: `${call.name} ${JSON.stringify(call.input)}`, message, lead: this.#lead.id });
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
Expected: 15 tests pass, and no type errors.

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
  shows a notice and logs it (Task 6). The reply is priced as the model that answered (`servedBy`).
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
import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import { fromAnthropic, toAnthropic } from "../../src/providers/anthropic.js";

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

  it("reports refusals and hitting a limit", () => {
    const refused = fromAnthropic(message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as BetaMessage["stop_details"] }));
    expect(refused.cutOff).toEqual({ kind: "refusal", detail: "The model declined (category: cyber)" });
    expect(fromAnthropic(message({ stop_reason: "max_tokens" })).cutOff?.kind).toBe("max_tokens");
    expect(fromAnthropic(message({ stop_reason: "model_context_window_exceeded" })).cutOff?.kind).toBe("max_tokens");
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
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";
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
  return messages.map((m) =>
    m.role === "assistant" && m.native?.provider === "anthropic"
      ? { role: "assistant", content: m.native.content as BetaContentBlockParam[] }
      : { role: m.role, content: m.parts.map(toBlock) },
  );
}

export function fromAnthropic(msg: BetaMessage): Turn {
  const parts: Part[] = [];
  const fallbacks: { from: string; to: string }[] = [];
  for (const b of msg.content) {
    if (b.type === "text") parts.push({ type: "text", text: b.text });
    else if (b.type === "tool_use") parts.push({ type: "tool_call", id: b.id, name: b.name, input: b.input });
    else if (b.type === "fallback") fallbacks.push({ from: b.from.model, to: b.to.model });
  }
  const u = msg.usage;
  const turn: Turn = {
    parts,
    native: { provider: "anthropic", content: msg.content },
    usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
  };
  if (fallbacks.length) {
    turn.fallbacks = fallbacks;
    turn.servedBy = `anthropic:${fallbacks.at(-1)!.to}`;
  }
  if (msg.stop_reason === "max_tokens") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (msg.stop_reason === "model_context_window_exceeded") turn.cutOff = { kind: "max_tokens", detail: "The conversation filled the context window" };
  if (msg.stop_reason === "refusal") turn.cutOff = { kind: "refusal", detail: `The model declined (category: ${msg.stop_details?.category ?? "none given"})` };
  return turn;
}

export class AnthropicProvider implements Provider {
  readonly id: string;
  #client = new Anthropic(); // credentials from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile
  #window?: Promise<number | null>;

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

  contextWindow(): Promise<number | null> {
    this.#window ??= this.#client.models.retrieve(this.model).then(
      (m) => m.max_input_tokens,
      () => null,
    );
    return this.#window;
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/providers/anthropic.test.ts && npm run typecheck`
Expected: 5 tests pass, and no type errors.

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
import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import type { Message } from "../../src/core/types.js";
import { fromOpenAI, toOpenAI } from "../../src/providers/openai.js";

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
    expect(toOpenAI("sys", history)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "looking", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "Error: nope" },
      { role: "user", content: "and?" },
    ]);
  });

  it("converts Anthropic turns too, ignoring their native content", () => {
    const history: Message[] = [{ role: "assistant", parts: [{ type: "text", text: "hi" }], native: { provider: "anthropic", content: [] } }];
    expect(toOpenAI("s", history)[1]).toEqual({ role: "assistant", content: "hi" });
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
    );
    expect(turn.parts).toEqual([{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }]);
    expect(turn.usage).toEqual({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0 });
  });

  it("passes broken tool arguments on so the schema check rejects them", () => {
    const turn = fromOpenAI(completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{oops" } }] }));
    expect(turn.parts[0]).toMatchObject({ input: { invalid_json: "{oops" } });
  });

  it("reports hitting the output limit and content filtering", () => {
    expect(fromOpenAI(completion({ content: "par" }, "length")).cutOff?.kind).toBe("max_tokens");
    expect(fromOpenAI(completion({ content: "" }, "content_filter")).cutOff?.kind).toBe("refusal");
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

export function toOpenAI(system: string, messages: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
    if (m.role === "assistant") {
      const calls = m.parts.flatMap((p) => (p.type === "tool_call" ? [p] : []));
      out.push({
        role: "assistant",
        content: text || null,
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

export function fromOpenAI(res: ChatCompletion): Turn {
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
  if (choice.finish_reason === "length") turn.cutOff = { kind: "max_tokens", detail: "The response hit the output limit" };
  if (choice.finish_reason === "content_filter") turn.cutOff = { kind: "refusal", detail: "The provider's content filter stopped the response" };
  return turn;
}

export class OpenAIProvider implements Provider {
  readonly id: string;
  #client: OpenAI;

  constructor(
    readonly kind: string,
    readonly model: string,
  ) {
    const preset = PRESETS[kind];
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
        { model: this.model, messages: toOpenAI(system, messages), ...(specs.length ? { tools: specs } : {}) },
        { signal },
      );
      return fromOpenAI(res);
    } catch (err) {
      if (err instanceof OpenAI.APIConnectionError) {
        throw new Error(`Could not reach ${this.#client.baseURL} (${err.message}). Check the address, your network, or that the server is running.`);
      }
      throw err;
    }
  }
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/providers/openai.test.ts && npm run typecheck`
Expected: 5 tests pass, and no type errors.

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
  if (kind in PRESETS) return new OpenAIProvider(kind, model);
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

// USD per million tokens, copied 2026-10-22 from the claude-api skill's model table (cached
// 2026-10-06) and its prompt-caching notes: cache reads as listed per model, cache writes 1.25x input
// (5-minute cache). Claude Haiku 5.5 is left out because its price changes above 100K-token prompts.
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
Expected: 9 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/providers/registry.ts src/providers/pricing.ts tests/providers/registry.test.ts
git commit -m "feat: provider registry and pricing table"
```

### Task 10: Error log and running totals

Every error event becomes one JSON line in `.tachikoma/errors.jsonl`. `Stats` keeps the totals the status line shows.

**Files:**
- Create: `src/core/errorlog.ts`
- Create: `src/core/stats.ts`
- Test: `tests/core/errorlog.test.ts`

**Step 1: Write the failing test**

`tests/core/errorlog.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("says so when there is no log yet", () => {
    expect(summarize(path.join(tmpdir(), "does-not-exist.jsonl"))).toBe("No errors logged yet.");
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Bus, ErrorEvent } from "./bus.js";

type Row = ErrorEvent & { at: string; session: string };

// One JSON line per failure, in the project's .tachikoma folder.
export function attachErrorLog(bus: Bus, file: string, session: string): void {
  bus.on("error", (e) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const row: Row = { at: new Date().toISOString(), session, ...e };
    appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
  });
}

export function summarize(file: string): string {
  if (!existsSync(file)) return "No errors logged yet.";
  const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (rows.length === 0) return "No errors logged yet.";
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const last = rows.at(-1)!;
  return [
    `${rows.length} errors logged in ${file}`,
    ...[...counts].map(([kind, n]) => `  ${kind}: ${n}`),
    `Most recent (${last.at}): ${last.attempted}\n  ${last.message.split("\n")[0]}`,
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
Expected: 4 tests pass, and no type errors.

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
import { describe, expect, it } from "vitest";
import { describe as describeMessage } from "../../src/tui/describe.js";
import { SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";

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

describe("StatusLine", () => {
  it("shows every part by default", () => {
    const frame = render(<StatusLine info={info} segments={SEGMENTS} />).lastFrame();
    expect(frame).toContain("lead anthropic:claude-opus-5-5");
    expect(frame).toContain("ctx 50%");
    expect(frame).toContain("12.3k in / 678 out");
    expect(frame).toContain("$0.42");
    expect(frame).toContain("perm ask");
    expect(frame).toContain("2 errors");
  });

  it("shows only the chosen parts, and raw context size when the window is unknown", () => {
    const frame = render(<StatusLine info={{ ...info, contextWindow: null, costUnknown: true }} segments={["context", "cost"]} />).lastFrame();
    expect(frame).toContain("ctx 500.0k");
    expect(frame).toContain("$0.42 + ?");
    expect(frame).not.toContain("lead");
  });
});

describe("describe", () => {
  it("shows tool calls and failed results on one line each", () => {
    const lines = describeMessage(
      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "exit code: 1\nlots more", isError: true }] },
      80,
    );
    expect(lines).toEqual([{ text: "  ⎿ exit code: 1", color: "red" }]);
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

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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
        <Text key={s} inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
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
import type { Message } from "../core/types.js";

export interface Line {
  text: string;
  color?: string;
}

const firstLine = (s: string) => s.split("\n")[0] ?? "";
const fit = (s: string, width: number) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`);

// How one message appears in the scrollback.
export function describe(m: Message, width = process.stdout.columns ?? 80): Line[] {
  const lines: Line[] = [];
  for (const p of m.parts) {
    if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
    else if (p.type === "tool_call") lines.push({ text: fit(`● ${p.name} ${JSON.stringify(p.input)}`, width), color: "yellow" });
    else lines.push({ text: fit(`  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, width), color: p.isError ? "red" : "gray" });
  }
  return lines;
}
```

**Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/tui/statusline.test.tsx && npm run typecheck`
Expected: 3 tests pass, and no type errors.

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
import path from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { PermissionGate } from "../../src/core/permissions.js";
import { Session } from "../../src/core/session.js";
import { Stats } from "../../src/core/stats.js";
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

async function mount(turns: ConstructorParameters<typeof FakeProvider>[1]) {
  const bus = new Bus();
  const stats = new Stats(bus);
  const ctx = await tempContext();
  let ask: (s: string) => Promise<boolean> = async () => false;
  const gate = new PermissionGate("ask", (s) => ask(s));
  const session = new Session({ lead: new FakeProvider("a", turns), tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
  const app = render(
    <App
      session={session}
      bus={bus}
      stats={stats}
      mode="ask"
      errorFile={path.join(ctx.root, "errors.jsonl")}
      segments={SEGMENTS}
      makeProvider={() => new FakeProvider("b", [])}
      bindAsk={(fn) => {
        ask = fn;
      }}
    />,
  );
  await tick();
  return { app, session, ctx, bus };
}

async function type(app: ReturnType<typeof render>, text: string) {
  app.stdin.write(text);
  await tick();
  app.stdin.write("\r");
  await tick();
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

  it("switches the lead with /lead", async () => {
    const { app, session } = await mount([]);
    await type(app, "/lead fake:b");
    expect(session.lead.id).toBe("fake:b");
    expect(app.lastFrame()).toContain("lead is now fake:b");
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
import { describe, type Line } from "./describe.js";
import { type Segment, StatusLine } from "./StatusLine.js";

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
  const [question, setQuestion] = useState<{ text: string; answer: (ok: boolean) => void } | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [, rerender] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(0);

  const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...x, id: nextId.current++ }))]);

  useEffect(() => {
    bindAsk((text) => new Promise((resolve) => setQuestion({ text, answer: resolve })));
    const onMessage = (m: Message) => say(...describe(m));
    const onError = (e: ErrorEvent) => {
      if (e.kind === "tool") rerender((n) => n + 1);
      else if (e.kind === "fallback") say({ text: `↪ ${e.message}`, color: "magenta" });
      else say({ text: `✗ ${e.kind}: ${e.message}`, color: "red" });
    };
    const onUsage = () => rerender((n) => n + 1);
    const onLead = (id: string) => {
      say({ text: `lead is now ${id}`, color: "magenta" });
      session.lead.contextWindow?.().then(setContextWindow) ?? setContextWindow(null);
    };
    bus.on("message", onMessage);
    bus.on("error", onError);
    bus.on("usage", onUsage);
    bus.on("lead", onLead);
    session.lead.contextWindow?.().then(setContextWindow);
    return () => {
      bus.off("message", onMessage);
      bus.off("error", onError);
      bus.off("usage", onUsage);
      bus.off("lead", onLead);
    };
  }, []);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text === "/exit") return exit();
    if (text === "/errors") return say({ text: summarize(errorFile) });
    if (text.startsWith("/lead ")) {
      try {
        session.setLead(makeProvider(text.slice("/lead ".length).trim()));
      } catch (err) {
        say({ text: errorText(err), color: "red" });
      }
      return;
    }
    abort.current = new AbortController();
    setBusy(true);
    try {
      await session.send(text, abort.current.signal);
    } finally {
      setBusy(false);
    }
  };

  useInput((ch, key) => {
    if (question) {
      if (ch === "y" || ch === "n") {
        say({ text: `${question.text}: ${ch === "y" ? "allowed" : "declined"}`, color: "gray" });
        question.answer(ch === "y");
        setQuestion(null);
      }
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
Expected: 5 tests pass, and no type errors.

**Step 5: Commit**

```bash
git add src/tui/App.tsx tests/tui/app.test.tsx
git commit -m "feat: interactive screen"
```

### Task 13: Command-line entry point

**Files:**
- Create: `src/core/prompt.ts`, `src/cli.tsx`

**Step 1: Write the code**

`src/core/prompt.ts`:

```typescript
import { shellFor } from "../exec/local.js";

// Built once per session and never changed after (see SessionOptions.system).
export function systemPrompt(root: string, platform: NodeJS.Platform = process.platform): string {
  return [
    "You are Tachikoma, a coding agent working in the user's terminal.",
    `The project root is ${root}. File paths are relative to it.`,
    `Shell commands run with ${shellFor(platform).name} on ${platform}.`,
    "Read files before changing them, prefer edit_file to rewriting whole files, and say plainly when something failed.",
  ].join("\n");
}
```

`src/cli.tsx`:

```tsx
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
```

**Step 2: Build and run the whole suite**

Run: `npm run typecheck && npm test && npm run build`
Expected: `Tests  71 passed`, then a `dist/` folder holding `cli.js`.

**Step 3: Smoke-test the command without any API key**

```bash
node dist/cli.js --help            # prints the help, exit 0
node dist/cli.js                   # "No lead model given. Pass --lead or set TACHI_LEAD." exit 1
node dist/cli.js --lead acme:x     # 'Unknown provider "acme". Known: anthropic, openai, openrouter, kimi, ollama' exit 1
node dist/cli.js --lead ollama:qwen3 --mode yolo    # "--mode must be one of: ask, project, never" exit 1
node dist/cli.js --lead ollama:none -p hi           # with no Ollama running: "provider: Could not reach http://localhost:11434/v1 ..." exit 1
cat .tachikoma/errors.jsonl        # one line for the failed request
```

All five gave exactly this output in the scratch build on 2026-10-22.

**Step 4: Commit**

```bash
git add src/core/prompt.ts src/cli.tsx
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
Expected: `Tests  71 passed | 1 skipped`.

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
