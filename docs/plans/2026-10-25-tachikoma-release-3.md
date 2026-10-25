# Tachikoma Release 3 (Claude Code's keys and screen): Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The session screen gets Claude Code's keys and feel: Esc stops a turn, the prompt edits as
a shell line does, with undo; prompts run over several lines; each project keeps its past prompts,
searched with Ctrl+R; what is typed during a turn waits in a queue; a `/` menu and `@` paths;
Shift+Tab switches the permission mode, Alt+P opens the model list, Ctrl+O prints the last turn's
tool calls and `?` lists the keys; a live working line, one-line tool calls, and a status line with
claude-hud's parts and a tool line under it.

**Architecture:** The prompt is plain data (`src/tui/editor.ts`: the text, the cursor, the undo
steps), laid out in screen rows by `src/tui/layout.ts`. `src/tui/keys.ts` turns the keys Ink reports
into commands, and App decides what a key means at that moment: an answer to a question, a menu
choice, a search or an edit. Each project's past prompts are a private file in the data folder
(`src/tui/history.ts`), written with release 2's private-file writer under its lock. The session's
only change is two events, `tool-start` and `tool-end`, which the working line and the tool line
read. The new screen parts are small components: `Prompt`, `Menu`, `WorkingLine` and `ToolLine`.
Design: `docs/plans/2026-10-25-tachikoma-release-3-design.md`.

**Tech stack:** as release 2 (Node 22+, TypeScript 7.0.2, Ink 7.1.1, React 19.3.0, zod 4.6.5,
Vitest 5.0.3, ink-testing-library), plus `string-width` 8.3.0 as a direct dependency (Task 5). It
was already installed under Ink; the prompt uses it to measure columns.

---

## Before you start

**This plan's code has already been run, one task at a time.** On 2026-10-25 every task below was
built in a scratch copy of the repo, in order, one commit per task, each task's tests written and
seen failing before its code. Every code block was then copied by script from those commits, not
retyped. Each task's counts below come from typechecking and running the whole suite at its commit,
one task at a time. After Task 14:
Test Files 34 passed | 2 skipped (36); Tests 553 passed | 7 skipped (560).
The tests left out are release 2's six (the live checks, which run only with `TACHI_LIVE=1`, and on
Windows its macOS/Linux file-mode test and, without Developer Mode, its link test), and on Windows
Task 2's macOS/Linux file-mode test.

**Reviewed:** a review of this plan's code found five bugs: a queued prompt sent while another ran,
word moves landing inside an emoji, Ctrl+U at the very start copying a line break, the tool line
pushing the model list a row too tall, and two keys in the `?` list that do not work in Windows
Terminal. Each is fixed in its task, its test written and seen failing first.

**The machine was busy** with other programs while these ran (20 to 53% of the processor when measured).
Tests that start PowerShell (private files, the keychain, signing in) then sometimes ran past
Vitest's 5 s limit, and release 1's "cancelling a command also stops the programs it started"
sometimes failed. Two at a time, as for release 2, gave 9 to 12 such failures a task, so each task
was run alone, and Tasks 4 to 14 again after the review's fixes. Tasks 1, 4, 7 and 9 had time-outs
in their last full run (Task 1 never had a run without one, on different tests each time): their
counts are the full run's, with each test that ran over passing when its file was run again.
Release 3 changes no sign-in code or sign-in tests.

**Not run yet:** release 3 in your own terminal (the checklist after Task 14), and on macOS and
Linux.

**Choices this plan makes that the design leaves open.** Each is marked in its task. The user
approved all ten on 2026-10-25.
1. **Task 2, the history file:** one per project folder, named by a hash of the folder's real path,
   one prompt per line as a JSON string, kept in full and never shortened.
2. **Task 4, words** are letters, digits and marks, as in Readline. **Ctrl+K at a line's end and
   Ctrl+U at its start** take the line break, so they always delete something.
3. **Task 6, typed keys:** control characters in a typed chunk are dropped; a chunk is split at its
   line ends (a carriage return sends, a line feed makes a new line); Alt+Left and Alt+Right move
   one character, as the plain arrows do.
4. **Task 7:** the hint names the key pressed: "Press Ctrl-D again to exit" after Ctrl-D.
5. **Task 8, history:**
   - Ctrl+R ignores case, as the model picker does, and searches this project only (Claude Code's
     covers every project).
   - An empty search matches every prompt, newest first.
   - The match comes back with the cursor at its end; there is no highlight.
   - Pastes are ignored while searching.
   - Each start pays about 0.5 s once, just after the screen first draws, checking that the history
     folder is private (measured 465 to 545 ms). Keys typed meanwhile wait; none are lost.
6. **Task 9, the queue:**
   - A queued prompt goes into the history when Enter queues it.
   - Ctrl-D does not exit during a turn.
   - A queued entry's line breaks show as ⏎, one entry a row.
7. **Task 10, the prompt's space:**
   - The rows that say "↑ N rows above" and "↓ N rows below" appear only with 3 rows or more.
   - The "› " stays on the first row shown.
   - The prompt always gets at least the cursor's row.
   - With no row left for the queue, the hint line says "N queued".
   - The tests' terminal is 24 rows, Ink's own default size.
8. **Task 11, the menus:**
   - Enter runs the chosen command, as the design says. So typing `/login` and Enter signs in to
     ChatGPT, where before it printed how to use `/login`; Esc first still does that.
   - Tab fills the command's first word and a space (`/login `).
   - `@` narrows by the start of the name, in any case. Folders come first, then files, each by name.
     Hidden files are listed. A file is completed with a space after it.
   - A path with a space in it cannot be completed: the menu stops at the space.
9. **Task 12, the other keys:**
   - `?` lists the keys only when typed alone on an empty prompt; pasted, it is text.
   - "mode is now project" is grey, as the design says, where "lead is now" is magenta.
   - Alt+P during a turn waits in the queue, as `/model` typed then would.
   - Ctrl+O during a turn shows "(not finished)" for a call still waiting for its result.
   - The hint line keeps "? for shortcuts" when idle. Backslash then Enter and Ctrl+J are named in
     the key list `?` prints, not on the hint line, which has one row. (The design says both name
     them.)
10. **Task 13, the working line and the tool line:**
    - "↓ N tokens" counts the turn's output tokens.
    - `/login`, `/logout` and `/model` show no tokens or cost. `/logout`'s label is "Signing out"
      (the design names labels for a turn, `/login` and `/model` only).
    - Past an hour, the time stays in minutes and seconds ("75m 3s").
    - `read_file`'s line shows its path only, not where it starts reading.
    - The running call is written as the design writes it, "◐ shell npm test", without the colon
      claude-hud puts after the name.
    - Tools used as many times as each other keep the order they were first used in.
    - The tool line hides while the model list is open, since the list fills the rows above the
      status line.

**Different from the design** (the user's choices, 2026-10-25; the release 3 design's "As built"):
- **Undo is Ctrl+Z as well as Ctrl+_.** In Windows Terminal Ctrl+Shift+- sends Esc and Ctrl+- zooms,
  so Ctrl+_ cannot be typed there.
- **The word before the cursor goes with Alt+Backspace.** Ctrl+Backspace sends the same byte as
  Ctrl+H, which Ink reports as Backspace, so it acts as Backspace. Ctrl+W still deletes back to a
  space.
- **The git branch is read from `.git/HEAD`, without the `*` for changes.** Running `git status`
  would be a way round the approval checks: in `project` mode the model can write `.git/config`,
  whose settings can make git run programs.
- **The spinner moves every 80 ms,** the rate of the frames it uses. Once a second looked too slow.
  The time still counts in seconds.

**Numbers in the code, and where each came from:**

| Value | Source |
|---|---|
| A second press counts within 800 ms | Claude Code's docs give 800 ms for pressing Ctrl+D twice (interactive-mode.md, read 2026-10-23) |
| The spinner's frames, one every 80 ms | cli-spinners' "dots" (sindresorhus/cli-spinners, `spinners.json`, read 2026-10-25); its own interval is 80 ms |
| A context bar of 10 cells, yellow from 70% used and red from 85% | claude-hud 0.0.4 (`coloredBar` and `getContextColor`, `src/render/colors.ts`) |
| The session's length as `<1m`, `14m`, `1h 5m` | claude-hud 0.0.4 (`formatSessionDuration`, `src/index.ts`) |
| The tool line shows the 4 most used tools | claude-hud 0.0.4 (`renderToolsLine`, `src/render/tools-line.ts`) |
| The live part of the screen stays 1 row shorter than the terminal | Ink 7.1.1: at full height it clears the terminal and prints the scrollback again on every redraw (`renderInteractiveFrame`, `ink.js`) |
| The prompt's text is 3 columns narrower than the terminal | 2 for "› " in front, 1 kept free so the cursor never wraps |
| 15 s for the test of two sessions saving at once | Measured: alone it took 3.8 to 9.4 s on 2026-10-25, with the machine busy; 15 s, as for release 2's tests that start processes |
| A 24-row terminal in the App tests | Ink's own default size when a terminal reports none (`getWindowSize`) |

**Sources:** Claude Code's keys from code.claude.com/docs/en/interactive-mode.md and keybindings.md
(read 2026-10-23, Ctrl+R's details again on 2026-10-25). Ink 7.1.1 and claude-hud 0.0.4 as read in
the release 3 design. The keys your terminal sends, from the probes run in it on 2026-10-25 (main
design, item 18).

**Known limits of release 3:**
- **Windows Terminal sends Shift+Enter as Enter:** it does not answer for the kitty keyboard
  protocol. Backslash then Enter, or Ctrl+J, makes a new line in every terminal.
- **Ctrl+O prints below the conversation**; opening tool calls in place needs the full screen
  (release 5).
- **The `/` menu works only at the start of the prompt, and `@` lists one folder at a time**
  (the design's "Not in this release").

## Tasks

### Task 1: The session reports each tool call as it runs

The session's only change (release 3 design, "How it is built"). It runs a reply's calls one after
another but reported their results together, so the screen could not tell which call was running.
Two new events on the bus:
- `tool-start` (the call's id, name and input), just before a call runs;
- `tool-end` (the call's id and how it ended): `ok`, `failed`, `declined` (the user said no, or the
  mode refused it) or `cancelled` (Esc or Ctrl-C). A refusal that comes while the turn is being
  stopped counts as `cancelled`.

A call skipped because the turn was already stopped gets both at once, ending `cancelled`. Calls
never taken up, because the reply was cut off, get neither. The results still reach the
conversation together, as before.

**Files:**
- Modify: `src/core/bus.ts`
- Modify: `src/core/session.ts`
- Modify: `tests/core/session.test.ts`

**Step 1: Write the failing tests**

**Change `tests/core/session.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/session.test.ts b/tests/core/session.test.ts
index 23c25de..ad4affd 100644
--- a/tests/core/session.test.ts
+++ b/tests/core/session.test.ts
@@ -255,3 +255,67 @@ describe("Session", () => {
     expect(seen).toEqual([{ provider: "fake:x", usage, priceKnown: false }, { provider: "fake:y", usage }]); // last sets the context size
   });
 });
+
+describe("Session tool events", () => {
+  // Every tool event in order, as "start <id> <name> <input>" and "end <id> <outcome>".
+  function watch(bus: Bus): string[] {
+    const seen: string[] = [];
+    bus.on("tool-start", (c) => seen.push(`start ${c.id} ${c.name} ${JSON.stringify(c.input)}`));
+    bus.on("tool-end", (c) => seen.push(`end ${c.id} ${c.outcome}`));
+    return seen;
+  }
+  const calls = (...c: [string, string, unknown][]) => ({ parts: c.map(([id, name, input]) => ({ type: "tool_call" as const, id, name, input })), usage });
+
+  it("reports each call as it starts and ends, before the results reach the conversation", async () => {
+    const { session, bus } = await setup([calls(["c1", "echo", { text: "a" }], ["c2", "boom", {}], ["c3", "shy", {}], ["c4", "nope", {}]), reply("ok")]);
+    const seen = watch(bus);
+    bus.on("message", (m) => m.parts[0]?.type === "tool_result" && seen.push("results"));
+    await session.send("go");
+    expect(seen).toEqual([
+      'start c1 echo {"text":"a"}',
+      "end c1 ok",
+      "start c2 boom {}",
+      "end c2 failed",
+      "start c3 shy {}",
+      "end c3 declined",
+      "start c4 nope {}",
+      "end c4 failed",
+      "results",
+    ]);
+  });
+
+  it("ends a call stopped while it runs as cancelled, and one skipped after the stop too", async () => {
+    const abort = new AbortController();
+    const slow = defineTool("slow", "Stops the turn while it runs", z.object({}), async () => {
+      abort.abort();
+      throw new Error("Cancelled");
+    });
+    const bus = new Bus();
+    const seen = watch(bus);
+    const lead = new FakeProvider("a", [calls(["c1", "slow", {}], ["c2", "slow", {}])]);
+    const session = new Session({ lead, tools: [slow], system: "t", ctx: await tempContext(), bus });
+    await session.send("go", abort.signal);
+    expect(seen).toEqual(["start c1 slow {}", "end c1 cancelled", "start c2 slow {}", "end c2 cancelled"]);
+  });
+
+  it("ends a call declined because the turn was stopped at its question as cancelled", async () => {
+    const abort = new AbortController();
+    const asked = defineTool("asked", "Stopped at its question", z.object({}), async () => {
+      abort.abort(); // Ctrl-C at the question declines and stops the turn
+      throw new Declined("The user declined: asked");
+    });
+    const bus = new Bus();
+    const seen = watch(bus);
+    const session = new Session({ lead: new FakeProvider("a", [calls(["c1", "asked", {}])]), tools: [asked], system: "t", ctx: await tempContext(), bus });
+    await session.send("go", abort.signal);
+    expect(seen).toEqual(["start c1 asked {}", "end c1 cancelled"]);
+  });
+
+  it("reports nothing for the calls in a reply that was cut off, since none of them runs", async () => {
+    const cut = { ...callTool("c1", "echo", { text: "x" }), cutOff: { kind: "max_tokens" as const, detail: "limit" } };
+    const { session, bus } = await setup([cut]);
+    const seen = watch(bus);
+    await session.send("go");
+    expect(seen).toEqual([]);
+  });
+});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/session.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1); Tests 3 failed | 25 passed (28). Neither event is sent yet.

**Step 3: Write the code**

**Change `src/core/bus.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/bus.ts b/src/core/bus.ts
index fbb82bb..b621e2a 100644
--- a/src/core/bus.ts
+++ b/src/core/bus.ts
@@ -8,11 +8,18 @@ export interface ErrorEvent {
   lead: string;
 }
 
+// How a tool call ended. "declined": the user said no, or the mode refused it. "cancelled": the turn
+// was stopped (Esc or Ctrl-C) while the call ran, waited at its question, or had not started.
+export type ToolOutcome = "ok" | "failed" | "declined" | "cancelled";
+
 export interface Events {
   message: [Message];
   usage: [{ provider: string; usage: Usage; priceKnown?: boolean }];
   error: [ErrorEvent];
   lead: [string];
+  // Each call the session takes up, as it runs; its result reaches the conversation with the others.
+  "tool-start": [{ id: string; name: string; input: unknown }];
+  "tool-end": [{ id: string; outcome: ToolOutcome }];
 }
 
 // The session emits; the interface, status line, headless output and error log listen.
```

**Change `src/core/session.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/session.ts b/src/core/session.ts
index a9ef1dc..326ef3c 100644
--- a/src/core/session.ts
+++ b/src/core/session.ts
@@ -1,6 +1,6 @@
 import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
 import type { Tool, ToolContext } from "../tools/tool.js";
-import type { Bus } from "./bus.js";
+import type { Bus, ToolOutcome } from "./bus.js";
 import { Declined } from "./permissions.js";
 import { errorText, type Message, type Provider, type ToolCall, type ToolResult, type Turn } from "./types.js";
 
@@ -112,19 +112,28 @@ export class Session {
   }
 
   async #runTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
-    if (signal?.aborted) return result(call, "Cancelled by the user.", true);
-    const fail = (message: string) => {
+    const { bus } = this.opts;
+    bus.emit("tool-start", { id: call.id, name: call.name, input: call.input });
+    const [res, outcome] = await this.#execute(call, signal);
+    bus.emit("tool-end", { id: call.id, outcome });
+    return res;
+  }
+
+  async #execute(call: ToolCall, signal?: AbortSignal): Promise<[ToolResult, ToolOutcome]> {
+    if (signal?.aborted) return [result(call, "Cancelled by the user.", true), "cancelled"];
+    const fail = (message: string): [ToolResult, ToolOutcome] => {
       // Capped like the message: a failed write_file's input is the whole file.
       this.opts.bus.emit("error", { kind: "tool", attempted: truncate(`${call.name} ${JSON.stringify(call.input)}`), message, lead: this.#lead.id });
-      return result(call, message, true);
+      return [result(call, message, true), "failed"];
     };
     const tool = this.opts.tools.find((t) => t.spec.name === call.name);
     if (!tool) return fail(`Unknown tool: ${call.name}`);
     try {
-      return result(call, truncate(await tool.run(call.input, { ...this.opts.ctx, signal })), false);
+      return [result(call, truncate(await tool.run(call.input, { ...this.opts.ctx, signal })), false), "ok"];
     } catch (err) {
-      if (err instanceof Declined) return result(call, err.message, true);
-      if (signal?.aborted) return result(call, "Cancelled by the user.", true); // not a failure, so not logged
+      // Ctrl-C at a question declines it and stops the turn: the call was cancelled, not declined.
+      if (err instanceof Declined) return [result(call, err.message, true), signal?.aborted ? "cancelled" : "declined"];
+      if (signal?.aborted) return [result(call, "Cancelled by the user.", true), "cancelled"]; // not a failure, so not logged
       return fail(truncate(errorText(err)));
     }
   }
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 26 passed | 2 skipped (28); Tests 416 passed | 6 skipped (422).

**Step 5: Commit**

```bash
git add src/core/bus.ts src/core/session.ts tests/core/session.test.ts
git commit -m "feat: the session reports each tool call as it starts and ends"
```

### Task 2: Each project's past prompts, in a private file

`src/tui/history.ts` (release 3 design, "How it is built"; choice 1). `historyFile(root)` names the
project's file: `history/<hash of the folder's real path>.jsonl` in Tachikoma's data folder. Each
line is one prompt as a JSON string, so line breaks stay inside it.
- **Saving** reads the file again, adds the prompt and writes the whole file, with release 2's
  private-file writer under its lock, so two sessions in one project never lose each other's
  prompts. The test starts two real processes saving 20 prompts each.
- **A damaged line is skipped.** A file that cannot be read or saved is said once a session, through
  the `warn` it is given, and the prompt is still sent.

Every test that reaches the private-file code uses a path two levels inside a fresh temporary
folder, so making a folder private never touches a folder the test did not make.

**Files:**
- Create: `src/tui/history.ts`
- Create: `tests/tui/history.test.ts`

**Step 1: Write the failing tests**

**Create `tests/tui/history.test.ts`:**

```ts
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { History, historyFile } from "../../src/tui/history.js";

const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-history-"));
const historyUrl = pathToFileURL(path.resolve("src/tui/history.ts")).href;

describe("History", () => {
  it("keeps every prompt of a project, line breaks and all, for the next session", async () => {
    const file = path.join(temp(), "history", "p.jsonl");
    const one = new History(file, () => {});
    expect(one.load()).toEqual([]);
    await one.add("first");
    await one.add("two\nlines");
    expect(one.entries).toEqual(["first", "two\nlines"]);
    expect(new History(file, () => {}).load()).toEqual(["first", "two\nlines"]);
    expect(readFileSync(file, "utf8")).toBe(`"first"\n${JSON.stringify("two\nlines")}\n`); // one prompt a line
  });

  it("is a private file in Tachikoma's data folder, one for each project folder", () => {
    const data = temp();
    const a = historyFile(path.join(data, "..", "a"), data);
    expect(path.dirname(a)).toBe(path.join(data, "history"));
    expect(historyFile(path.join(data, "..", "b"), data)).not.toBe(a);
    expect(historyFile(path.join(data, "..", "a", "."), data)).toBe(a);
  });

  it.skipIf(process.platform === "win32")("can be read only by the user (macOS and Linux)", async () => {
    const file = path.join(temp(), "history", "p.jsonl");
    await new History(file, () => {}).add("x");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("skips a damaged line and keeps the rest", () => {
    const dir = path.join(temp(), "history");
    mkdirSync(dir);
    const file = path.join(dir, "p.jsonl");
    writeFileSync(file, '"good"\n{"half\n42\n"also good"\n');
    expect(new History(file, () => {}).load()).toEqual(["good", "also good"]);
  });

  // Two processes start. Alone it took 3.8 to 9.4 s on 2026-10-25, with the machine busy; 15 s, as for
  // the other tests that start processes (tests/cli.test.ts).
  it("keeps the prompts of two sessions saving at once", async () => {
    const dir = temp();
    const file = path.join(dir, "history", "p.jsonl");
    const sessions = ["a", "b"].map((tag) => {
      const script = path.join(dir, `${tag}.mts`);
      writeFileSync(script, `import { History } from ${JSON.stringify(historyUrl)};\nconst h = new History(${JSON.stringify(file)}, (l) => console.error(l));\nfor (let i = 0; i < 20; i++) await h.add("${tag}" + i);\n`);
      const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "ignore", "inherit"] });
      return new Promise((resolve) => child.on("close", resolve));
    });
    expect(await Promise.all(sessions)).toEqual([0, 0]);
    const saved = new History(file, () => {}).load();
    expect(saved).toHaveLength(40);
    for (const tag of ["a", "b"]) expect(saved.filter((s) => s.startsWith(tag))).toEqual([...Array(20).keys()].map((i) => `${tag}${i}`));
  }, 15_000);

  it("says once when the file cannot be read or saved, and keeps the prompts for this session", async () => {
    const dir = path.join(temp(), "history");
    const file = path.join(dir, "p.jsonl");
    mkdirSync(file, { recursive: true }); // a folder where the file should be
    const said: string[] = [];
    const h = new History(file, (line) => said.push(line));
    expect(h.load()).toEqual([]);
    await h.add("one");
    await h.add("two");
    expect(h.entries).toEqual(["one", "two"]);
    expect(said).toEqual([`The prompt history could not be read or saved: ${file} is not a plain file, so it was not used`]);
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/history.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/tui/history.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/tui/history.ts`:**

```ts
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { withLock } from "../auth/lock.js";
import { privateDir, readPrivate, writePrivate } from "../auth/private.js";
import { dataDir } from "../core/datadir.js";
import { errorText } from "../core/types.js";

// Each project folder's past prompts (release 3 design, "How it is built"): a private file in the data
// folder, named after the folder's real path, so two ways of writing one folder share it. One prompt a
// line, as a JSON string, so a prompt's own line breaks stay inside it; kept in full.
export function historyFile(root: string, data = dataDir()): string {
  let real: string;
  try {
    real = realpathSync.native(root); // Windows gives the folder's own case, whatever was typed
  } catch {
    real = path.resolve(root);
  }
  return path.join(data, "history", `${createHash("sha256").update(real).digest("hex")}.jsonl`);
}

// A damaged line is skipped, so the rest can still be used.
function parse(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return typeof entry === "string" ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export class History {
  // Oldest first: what was saved before this session, then this session's prompts.
  readonly entries: string[] = [];
  #warned = false;

  constructor(
    readonly file: string,
    private readonly warn: (line: string) => void,
  ) {}

  load(): string[] {
    try {
      this.entries.splice(0, this.entries.length, ...parse(readPrivate(this.file, this.warn) ?? ""));
    } catch (err) {
      this.#fail(err);
    }
    return this.entries;
  }

  // In this session's list at once; saved under the lock, which every Tachikoma process shares, after
  // reading the file again, so two sessions in one project never lose each other's prompts. Never
  // rejects: a prompt is still sent when it cannot be saved.
  add(text: string): Promise<void> {
    this.entries.push(text);
    return (async () => {
      privateDir(path.dirname(this.file)); // the lock file goes there too
      await withLock(`${this.file}.lock`, async () => {
        const saved = readPrivate(this.file, this.warn) ?? "";
        writePrivate(this.file, `${saved}${saved && !saved.endsWith("\n") ? "\n" : ""}${JSON.stringify(text)}\n`);
      });
    })().catch((err) => this.#fail(err));
  }

  // Said once a session, so a history that cannot be used does not fill the screen.
  #fail(err: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    this.warn(`The prompt history could not be read or saved: ${errorText(err)}`);
  }
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 27 passed | 2 skipped (29); Tests 421 passed | 7 skipped (428).

**Step 5: Commit**

```bash
git add src/tui/history.ts tests/tui/history.test.ts
git commit -m "feat: each project keeps its past prompts in a private file"
```

### Task 3: The status line: a context bar, the project and git branch, the session's length

Three of claude-hud's parts (release 3 design, "On screen"; the tool line is Task 13):
- **A context bar** before "ctx 81% left": ten cells, green, yellow from 70% used, red from 85%. It
  sits outside the inverse text, so its colours show. With no known window there is no bar.
- **`project`:** the folder's name, and `git:(branch)` inside a repository. `src/tui/git.ts` reads
  the branch from `.git/HEAD` (following a worktree's `.git` file; a detached head shows `HEAD`),
  at the start and after each turn. No `*` for changes: see "Different from the design".
- **`time`:** how long the session has run, as claude-hud writes it, redrawn once a minute.

`--status` takes `project` and `time`; all parts are on by default. App gains the props `project`
and `gitBranch`.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/StatusLine.tsx`
- Create: `src/tui/git.ts`
- Modify: `tests/clilib.test.ts`
- Modify: `tests/tui/app.test.tsx`
- Create: `tests/tui/git.test.ts`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/clilib.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/clilib.test.ts b/tests/clilib.test.ts
index 2e50308..fbe76fe 100644
--- a/tests/clilib.test.ts
+++ b/tests/clilib.test.ts
@@ -71,7 +71,7 @@ describe("statusSegments", () => {
   });
 
   it("names --status when a segment is unknown", () => {
-    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors (got "nope")');
+    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time (got "nope")');
   });
 });
 
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 75349d1..f89ce21 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -3,7 +3,7 @@ import { mkdtemp } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import path from "node:path";
 import { render } from "ink-testing-library";
-import { afterEach, describe, expect, it } from "vitest";
+import { afterEach, describe, expect, it, vi } from "vitest";
 import { PermissionGate } from "../../src/core/permissions.js";
 import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
@@ -11,7 +11,7 @@ import type { Provider } from "../../src/core/types.js";
 import { TOOLS } from "../../src/tools/index.js";
 import type { ModelGroup } from "../../src/providers/models.js";
 import { App, type AppProps } from "../../src/tui/App.js";
-import { SEGMENTS } from "../../src/tui/StatusLine.js";
+import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
 import { Bus, FakeProvider, callTool, reply, tempContext } from "../helpers.js";
 
 const tick = () => new Promise((r) => setTimeout(r, 50));
@@ -31,7 +31,7 @@ type Login = AppProps["login"];
 
 async function mount(
   turns: ConstructorParameters<typeof FakeProvider>[1],
-  opts: { lead?: Provider; errorFile?: string; login?: Login; models?: ModelGroup[]; note?: string; slow?: boolean; made?: string[] } = {},
+  opts: { lead?: Provider; errorFile?: string; login?: Login; models?: ModelGroup[]; note?: string; slow?: boolean; made?: string[]; segments?: Segment[]; branches?: string[] } = {},
 ) {
   const bus = new Bus();
   const stats = new Stats(bus);
@@ -46,8 +46,10 @@ async function mount(
       bus={bus}
       stats={stats}
       mode="ask"
+      project="proj"
+      gitBranch={() => opts.branches?.shift() ?? null}
       errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
-      segments={SEGMENTS}
+      segments={opts.segments ?? SEGMENTS}
       makeProvider={(spec) => {
         opts.made?.push(spec);
         return new FakeProvider("b", []);
@@ -91,6 +93,26 @@ function expectNoRawControls(frame: string | undefined) {
 }
 
 describe("App", () => {
+  it("shows the git branch, read again after each turn, since the model may switch it", async () => {
+    const { app } = await mount([reply("ok")], { segments: ["project"], branches: ["main", "side"] });
+    expect(app.lastFrame()).toContain("proj git:(main)");
+    await type(app, "switch");
+    await until(app, "proj git:(side)");
+  });
+
+  it("shows the project folder, and counts the session's length once a minute", async () => {
+    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
+    try {
+      const { app } = await mount([], { segments: ["project", "time"] });
+      expect(app.lastFrame()).toContain("proj | ⏱ <1m");
+      vi.advanceTimersByTime(60_000);
+      await tick();
+      expect(app.lastFrame()).toContain("proj | ⏱ 1m");
+    } finally {
+      vi.useRealTimers();
+    }
+  });
+
   it("sends what the user types and shows the reply", async () => {
     const { app } = await mount([reply("hello there")]);
     await type(app, "hi");
```

**Create `tests/tui/git.test.ts`:**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitBranch } from "../../src/tui/git.js";

// A folder with a repository's HEAD file, holding `head`.
function repo(head: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), head);
  return root;
}

describe("gitBranch", () => {
  it("reads the branch from the repository's HEAD file, from the project folder or one inside it", () => {
    const root = repo("ref: refs/heads/feature/x\n");
    expect(gitBranch(root)).toBe("feature/x");
    mkdirSync(path.join(root, "src"));
    expect(gitBranch(path.join(root, "src"))).toBe("feature/x");
  });

  it("says HEAD when no branch is checked out, as git does", () => {
    expect(gitBranch(repo("0123456789abcdef0123456789abcdef01234567\n"))).toBe("HEAD");
  });

  it("follows a .git file to the repository it names, as a worktree has", () => {
    const main = repo("ref: refs/heads/main\n");
    const worktree = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
    mkdirSync(path.join(main, ".git", "worktrees", "w"), { recursive: true });
    writeFileSync(path.join(main, ".git", "worktrees", "w", "HEAD"), "ref: refs/heads/side\n");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "w")}\n`);
    expect(gitBranch(worktree)).toBe("side");
  });

  it("gives nothing outside a repository, or when HEAD cannot be read", () => {
    expect(gitBranch(mkdtempSync(path.join(tmpdir(), "tachi-git-")))).toBeNull();
    const broken = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
    mkdirSync(path.join(broken, ".git"));
    expect(gitBranch(broken)).toBeNull();
  });
});
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index 863b17e..18aee9a 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -1,7 +1,7 @@
 import { render } from "ink-testing-library";
 import { describe, expect, it, vi } from "vitest";
 import { describe as describeMessage, screen } from "../../src/tui/describe.js";
-import { formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";
+import { contextBar, duration, formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";
 
 const info: StatusInfo = {
   lead: "anthropic:claude-opus-5-5",
@@ -13,6 +13,9 @@ const info: StatusInfo = {
   costUnknown: false,
   mode: "ask",
   errors: 2,
+  project: "Agent Harness",
+  branch: "main",
+  elapsed: 14 * 60_000,
 };
 
 // Renders once and unmounts, so Ink instances do not pile up.
@@ -25,13 +28,44 @@ function frame(i: StatusInfo, segments: Segment[]) {
 
 describe("StatusLine", () => {
   it("shows every part by default", () => {
-    const shown = frame(info, SEGMENTS);
+    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time"]);
+    // In two parts: all of them are wider than the test terminal's 100 columns.
+    const shown = frame(info, SEGMENTS.slice(0, 4));
     expect(shown).toContain("lead anthropic:claude-opus-5-5");
     expect(shown).toContain("ctx 50% left");
     expect(shown).toContain("12.3k in / 678 out");
     expect(shown).toContain("$0.42");
-    expect(shown).toContain("perm ask");
-    expect(shown).toContain("2 errors");
+    expect(frame(info, SEGMENTS.slice(4))).toBe(" perm ask | 2 errors | Agent Harness git:(main) | ⏱ 14m");
+  });
+
+  it("puts a bar of the context used before how much is left", () => {
+    expect(frame({ ...info, context: 190_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██░░░░░░░░ ctx 81% left");
+    expect(frame({ ...info, context: 1_200_000, contextWindow: 1_000_000 }, ["context"])).toBe(" ██████████ ctx 0% left");
+    expect(frame({ ...info, context: 45_200, contextWindow: null }, ["context"])).toBe(" ctx 45.2k"); // no window, no bar
+  });
+
+  it.each([
+    [69, "green"],
+    [70, "yellow"],
+    [84, "yellow"],
+    [85, "red"],
+  ])("colours the bar at %d%% used %s", (percent, color) => {
+    expect(contextBar(percent).color).toBe(color);
+  });
+
+  it("shows the project folder and its git branch", () => {
+    expect(formatSegment("project", info)).toBe("Agent Harness git:(main)");
+    expect(formatSegment("project", { ...info, branch: null })).toBe("Agent Harness");
+    expect(formatSegment("project", { ...info, project: "a\u001b[2Jb", branch: "x\u0007" })).toBe("a\\u001b[2Jb git:(x\\u0007)");
+  });
+
+  it.each([
+    [59_999, "<1m"],
+    [60_000, "1m"],
+    [59 * 60_000, "59m"],
+    [65 * 60_000, "1h 5m"],
+  ])("writes %d ms of session as %s", (ms, shown) => {
+    expect(duration(ms)).toBe(shown);
   });
 
   it("shows only the chosen parts, and raw context size when the window is unknown", () => {
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/clilib.test.ts tests/tui/app.test.tsx tests/tui/git.test.ts tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 4 failed (4); Tests 14 failed | 63 passed (77). The bar, the two new parts and `src/tui/git.ts` do not exist yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 9dc0dc3..a19d733 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -19,6 +19,7 @@ import { listModels } from "./providers/models.js";
 import { createProvider } from "./providers/registry.js";
 import { TOOLS } from "./tools/index.js";
 import { App } from "./tui/App.js";
+import { gitBranch } from "./tui/git.js";
 import { SEGMENTS } from "./tui/StatusLine.js";
 
 const HELP = `tachi: a coding agent for your terminal
@@ -186,6 +187,8 @@ if (parsed.print !== undefined) {
       bus={bus}
       stats={stats}
       mode={mode}
+      project={path.basename(root) || root}
+      gitBranch={() => gitBranch(root)}
       errorFile={errorFile}
       segments={segments}
       makeProvider={makeProvider}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 18623e8..35acb1d 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -18,6 +18,8 @@ export interface AppProps {
   bus: Bus;
   stats: Stats;
   mode: Mode;
+  project: string; // the project folder's name, for the status line
+  gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
   errorFile: string;
   segments: Segment[];
   makeProvider: (spec: string) => Provider;
@@ -31,7 +33,7 @@ export interface AppProps {
 
 const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
 
-export function App({ session, bus, stats, mode, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, bus, stats, mode, project, gitBranch, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   const [input, setInput] = useState("");
@@ -40,6 +42,9 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
   const [contextWindow, setContextWindow] = useState<number | null>(null);
   const [picker, setPicker] = useState<ModelGroup[] | null>(null);
   const [, rerender] = useState(0);
+  const started = useRef(Date.now());
+  const [now, setNow] = useState(started.current);
+  const [branch, setBranch] = useState(gitBranch);
   const abort = useRef<AbortController | null>(null);
   const nextId = useRef(0);
   const lookups = useRef(0);
@@ -100,7 +105,9 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
     bus.on("usage", onUsage);
     bus.on("lead", onLead);
     lookUpWindow();
+    const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
     return () => {
+      clearInterval(minutes);
       bus.off("message", onMessage);
       bus.off("error", onError);
       bus.off("usage", onUsage);
@@ -138,6 +145,7 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
         } else await session.send(text, abort.current.signal);
       } finally {
         setBusy(false);
+        setBranch(gitBranch());
       }
     } catch (err) {
       say({ text: errorText(err), color: "red" });
@@ -200,6 +208,9 @@ export function App({ session, bus, stats, mode, errorFile, segments, makeProvid
           costUnknown: stats.costUnknown,
           mode,
           errors: stats.errors,
+          project,
+          branch,
+          elapsed: now - started.current,
         }}
       />
     </>
```

**Change `src/tui/StatusLine.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/StatusLine.tsx b/src/tui/StatusLine.tsx
index cfd4f7f..56b284f 100644
--- a/src/tui/StatusLine.tsx
+++ b/src/tui/StatusLine.tsx
@@ -1,7 +1,8 @@
 import { Text } from "ink";
+import { visible } from "../core/permissions.js";
 
-export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors";
-export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors"];
+export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time";
+export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time"];
 
 export interface StatusInfo {
   lead: string;
@@ -13,6 +14,9 @@ export interface StatusInfo {
   costUnknown: boolean;
   mode: string;
   errors: number;
+  project: string; // the project folder's name
+  branch: string | null; // the git branch; null outside a repository (see git.ts)
+  elapsed: number; // ms since the session started
 }
 
 // The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
@@ -22,6 +26,25 @@ const k = (n: number) => {
   return Number(thousands) < 1000 ? `${thousands}k` : `${(n / 1_000_000).toFixed(1)}M`;
 };
 
+// The share of the context window in use, rounded as "% left" is.
+const used = (i: StatusInfo) => Math.round((100 * i.context) / i.contextWindow!);
+
+// claude-hud's bar (`coloredBar` and `getContextColor` in its src/render/colors.ts, 0.0.4): ten cells,
+// filled in proportion to the share used, green, then yellow from 70% used and red from 85%.
+const BAR_CELLS = 10;
+export function contextBar(usedPercent: number): { filled: number; color: "green" | "yellow" | "red" } {
+  const filled = Math.min(BAR_CELLS, Math.max(0, Math.round((usedPercent / 100) * BAR_CELLS)));
+  return { filled, color: usedPercent >= 85 ? "red" : usedPercent >= 70 ? "yellow" : "green" };
+}
+
+// How long the session has run, as claude-hud writes it (`formatSessionDuration`, its src/index.ts).
+export function duration(ms: number): string {
+  const mins = Math.floor(ms / 60_000);
+  if (mins < 1) return "<1m";
+  if (mins < 60) return `${mins}m`;
+  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
+}
+
 export function formatSegment(s: Segment, i: StatusInfo): string {
   switch (s) {
     case "lead":
@@ -29,7 +52,7 @@ export function formatSegment(s: Segment, i: StatusInfo): string {
     case "context":
       // How much is left, as Codex shows it (main design, "Status line"); the tokens in use when the
       // window is not known.
-      return i.contextWindow ? `ctx ${Math.max(0, 100 - Math.round((100 * i.context) / i.contextWindow))}% left` : `ctx ${k(i.context)}`;
+      return i.contextWindow ? `ctx ${Math.max(0, 100 - used(i))}% left` : `ctx ${k(i.context)}`;
     case "tokens":
       return `${k(i.input)} in / ${k(i.output)} out`;
     case "cost": {
@@ -43,20 +66,38 @@ export function formatSegment(s: Segment, i: StatusInfo): string {
       return `perm ${i.mode}`;
     case "errors":
       return `${i.errors} errors`;
+    case "project":
+      // Folder and branch names come from the disk, so they are escaped like everything else on screen.
+      return visible(i.branch === null ? i.project : `${i.project} git:(${i.branch})`);
+    case "time":
+      return `⏱ ${duration(i.elapsed)}`;
   }
 }
 
 // One line, cut at the end to the terminal's width (Ink measures it in columns) instead of wrapping.
+// The text is inverse; the context bar is not, so its filled cells show in their colour.
 export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
   return (
-    <Text inverse wrap="truncate-end">
-      {segments.map((s, n) => (
-        <Text key={n} color={s === "errors" && info.errors > 0 ? "red" : undefined}>
-          {n === 0 ? " " : " | "}
-          {formatSegment(s, info)}
-          {n === segments.length - 1 ? " " : ""}
-        </Text>
-      ))}
+    <Text wrap="truncate-end">
+      {segments.map((s, n) => {
+        const bar = s === "context" && info.contextWindow ? contextBar(used(info)) : null;
+        return (
+          <Text key={n}>
+            <Text inverse>{n === 0 ? " " : " | "}</Text>
+            {bar && (
+              <>
+                <Text color={bar.color}>{"█".repeat(bar.filled)}</Text>
+                <Text dimColor>{"░".repeat(BAR_CELLS - bar.filled)}</Text>
+                <Text inverse> </Text>
+              </>
+            )}
+            <Text inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
+              {formatSegment(s, info)}
+              {n === segments.length - 1 ? " " : ""}
+            </Text>
+          </Text>
+        );
+      })}
     </Text>
   );
 }
```

**Create `src/tui/git.ts`:**

```ts
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// The project's git branch, read from the repository's HEAD file. No git program is run: in
// `project` mode the model can change .git/config without asking, and settings there name programs
// that `git status` runs, which would get round the approval shell commands need. So there is no mark
// for uncommitted changes (the user's choice, 2026-10-25). Null outside a repository, or when HEAD
// cannot be read.
export function gitBranch(root: string): string | null {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const st = statSync(dotGit, { throwIfNoEntry: false });
    if (st) {
      try {
        // A worktree's or submodule's .git is a file naming the repository: "gitdir: <path>".
        const gitDir = st.isDirectory() ? dotGit : path.resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir: /, "").trim());
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        // A commit checked out with no branch is "HEAD", as `git rev-parse --abbrev-ref HEAD` says.
        return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "HEAD";
      } catch {
        return null;
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 28 passed | 2 skipped (30); Tests 437 passed | 7 skipped (444).

**Step 5: Commit**

```bash
git add src/cli.tsx src/tui/App.tsx src/tui/StatusLine.tsx src/tui/git.ts tests/clilib.test.ts tests/tui/app.test.tsx tests/tui/git.test.ts tests/tui/statusline.test.tsx
git commit -m "feat: the status line shows a context bar, the project folder and the session time"
```

### Task 4: The prompt editor: moving, deleting, putting back and undo

`src/tui/editor.ts`, the prompt as plain data: the text, the cursor, the last deleted text and the
undo steps. `apply(editor, action)` returns the new editor, with no Ink in it, so every key is
tested by feeding it actions (release 3 design, "Editing").
- The cursor moves by grapheme (`Intl.Segmenter`), so an emoji or an accented letter is one step.
  Word moves and deletes go by grapheme too, so the cursor never lands inside one.
- Words are letters, digits and marks (choice 2). Ctrl+K at a line's end, and Ctrl+U at its start,
  take the line break; at the very start of the prompt, Home and Ctrl+U stay put.
- Ctrl+Y puts back what the last word or line delete took: Ctrl+W, Alt+Backspace, Alt+D, Ctrl+K or
  Ctrl+U.
- One undo step is a run of typing, ended by a move, a delete or a paste, back to the start of the
  prompt.

**Files:**
- Create: `src/tui/editor.ts`
- Create: `tests/tui/editor.test.ts`

**Step 1: Write the failing tests**

**Create `tests/tui/editor.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { type Action, apply, type Editor, empty, load } from "../../src/tui/editor.js";

// The text with the cursor shown as "|".
const show = (e: Editor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;
// An editor holding `text`, with "|" marking the cursor.
const at = (text: string) => ({ ...load(empty, text.replace("|", "")), cursor: text.indexOf("|") });
const run = (e: Editor, ...actions: Action[]) => actions.reduce(apply, e);
const typed = (text: string): Action => ({ type: "insert", text });

describe("editor", () => {
  it("types at the cursor", () => {
    expect(show(run(empty, typed("ab"), "left", typed("x")))).toBe("ax|b");
  });

  it("moves by character, past a character made of several code points as one", () => {
    expect(show(run(at("a👍🏽b|"), "left", "left"))).toBe("a|👍🏽b");
    expect(show(run(at("|ab"), "left"))).toBe("|ab");
    expect(show(run(at("ab|"), "right"))).toBe("ab|");
  });

  it("goes to the start and end of the line the cursor is on", () => {
    expect(show(run(at("one\ntw|o\nthree"), "home"))).toBe("one\n|two\nthree");
    expect(show(run(at("one\ntw|o\nthree"), "end"))).toBe("one\ntwo|\nthree");
  });

  it("moves by word, a word being letters and digits", () => {
    expect(show(run(at("|foo-bar baz9"), "wordRight"))).toBe("foo|-bar baz9");
    expect(show(run(at("|foo-bar baz9"), "wordRight", "wordRight", "wordRight"))).toBe("foo-bar baz9|");
    expect(show(run(at("foo-bar baz9|"), "wordLeft"))).toBe("foo-bar |baz9");
    expect(show(run(at("foo-bar |baz9"), "wordLeft"))).toBe("foo-|bar baz9");
    expect(show(run(at("café| x"), "wordLeft"))).toBe("|café x");
  });

  it("moves and deletes by word without splitting a character made of several code points", () => {
    const heart = "\u2764\uFE0F"; // a heart and the mark asking for it in colour
    expect(show(run(at(`hi ${heart}|`), "wordLeft"))).toBe(`|hi ${heart}`);
    expect(show(run(at(`|${heart} hi`), "wordRight"))).toBe(`${heart} hi|`);
    expect(show(run(at(`hi ${heart}|`), "deleteWord"))).toBe("|");
  });

  it("stays at the very start before a line break, for Home and Ctrl+U", () => {
    expect(show(run(at("|\nhello"), "home"))).toBe("|\nhello");
    expect(show(run(at("|\nhello"), "deleteToStart"))).toBe("|\nhello");
  });

  it("deletes the character before or after the cursor", () => {
    expect(show(run(at("ab|c"), "backspace"))).toBe("a|c");
    expect(show(run(at("ab|c"), "delete"))).toBe("ab|");
    expect(show(run(at("a👍🏽|b"), "backspace"))).toBe("a|b");
    expect(show(run(at("|ab"), "backspace"))).toBe("|ab");
    expect(show(run(at("ab|"), "delete"))).toBe("ab|");
  });

  it("deletes back to a space with Ctrl+W, and the word before with Alt+Backspace", () => {
    expect(show(run(at("git commit-msg  |"), "deleteToSpace"))).toBe("git |");
    expect(show(run(at("git commit-msg|"), "deleteWord"))).toBe("git commit-|");
  });

  it("deletes the word after the cursor", () => {
    expect(show(run(at("a |foo-bar"), "deleteWordAfter"))).toBe("a |-bar");
  });

  it("deletes to the end and to the start of the line, and the line break when there is nothing else", () => {
    expect(show(run(at("one\ntw|o\nthree"), "deleteToEnd"))).toBe("one\ntw|\nthree");
    expect(show(run(at("one\ntw|o\nthree"), "deleteToStart"))).toBe("one\n|o\nthree");
    expect(show(run(at("one|\ntwo"), "deleteToEnd"))).toBe("one|two");
    expect(show(run(at("one\n|two"), "deleteToStart"))).toBe("one|two");
  });

  it("puts back the text the last word or line delete took, but not a single character", () => {
    const e = run(at("hello world|"), "deleteToSpace", "home");
    expect(show(run(e, "yank"))).toBe("world|hello ");
    expect(show(run(e, "backspace", "end", "yank"))).toBe("hello world|"); // Backspace at the start deleted nothing
    expect(show(run(at("ab|"), "backspace", "yank"))).toBe("a|");
  });

  it("undoes a run of typing as one step, and each delete, paste and put-back as one", () => {
    const e = run(empty, typed("a"), typed("b"), typed(" "), typed("c"), "left", typed("d"), "backspace", { type: "paste", text: "P" }, "yank");
    expect(show(e)).toBe("ab P|c");
    const undone = [1, 2, 3, 4, 5].map((n) => show(run(e, ...Array<Action>(n).fill("undo"))));
    // The put-back had nothing to put back, so it was no step; then the paste, the Backspace, the
    // typed "d", and the first run of typing; then nothing more, at the start of the prompt.
    expect(undone).toEqual(["ab |c", "ab d|c", "ab |c", "|", "|"]);
  });

  it("puts a new line at the cursor, as part of typing", () => {
    const e = run(empty, typed("a"), "newline", typed("b"));
    expect(show(e)).toBe("a\nb|");
    expect(show(run(e, "undo"))).toBe("|");
  });

  it("starts a loaded prompt with the cursor at its end, nothing to undo, and the last deleted text kept", () => {
    const e = load(run(at("x yz|"), "deleteToSpace"), "two\nlines");
    expect(show(e)).toBe("two\nlines|");
    expect(show(run(e, "undo"))).toBe("two\nlines|");
    expect(show(run(e, "yank"))).toBe("two\nlinesyz|");
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/editor.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/tui/editor.ts` does not exist yet.

**Step 3: Write the code**

**Create `src/tui/editor.ts`:**

```ts
// The prompt editor as plain data (release 3 design, "How it is built"): `apply` takes the editor and
// one action and gives the new editor. Which key is which action is App's business, so every edit is
// tested here by feeding actions in.

export interface Editor {
  readonly text: string;
  readonly cursor: number; // a place between characters, as an index into `text`
  readonly undo: readonly { text: string; cursor: number }[]; // the states before each step, newest last
  readonly typing: boolean; // the last step was typing, so more typing joins it
  readonly killed: string; // what the last word or line delete took, for Ctrl+Y
}

export const empty: Editor = { text: "", cursor: 0, undo: [], typing: false, killed: "" };

export type Action =
  | { type: "insert"; text: string } // typed
  | { type: "paste"; text: string }
  | "newline"
  | "left"
  | "right"
  | "home" // the start of the line the cursor is on
  | "end"
  | "wordLeft"
  | "wordRight"
  | "backspace"
  | "delete"
  | "deleteToSpace" // Ctrl+W: back to the space before
  | "deleteWord" // Alt+Backspace: the word before
  | "deleteWordAfter" // Alt+D
  | "deleteToEnd" // Ctrl+K: to the end of the line
  | "deleteToStart" // Ctrl+U: to its start
  | "yank" // Ctrl+Y: put back what the last word or line delete took
  | "undo"; // Ctrl+Z or Ctrl+_

// A new prompt holding `text`, with the cursor at its end and nothing to undo. What the last delete
// took is kept, as a terminal's line editor keeps it from one command to the next.
export function load(e: Editor, text: string): Editor {
  return { ...empty, text, cursor: text.length, killed: e.killed };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The places between characters as the screen shows them, so an emoji made of several code points
// is passed over and deleted as one.
function boundaries(text: string): number[] {
  return [...[...segmenter.segment(text)].map((s) => s.index), text.length];
}
const before = (text: string, i: number) => boundaries(text).findLast((b) => b < i) ?? 0;
const after = (text: string, i: number) => boundaries(text).find((b) => b > i) ?? text.length;

// GNU Readline's words: letters and digits (with their accents, which are code points of their own).
const wordChar = (c: string) => /[\p{L}\p{N}\p{M}]/u.test(c);
const space = (c: string) => /\s/u.test(c);

// Back over characters that are not `inWord`, then over those that are, a character as the screen
// shows it, so the cursor never lands inside one. Each is judged by its first code point.
function back(text: string, i: number, inWord: (c: string) => boolean): number {
  const b = boundaries(text);
  let k = b.findLastIndex((x) => x < i); // the character before `i` starts at b[k]
  const char = () => String.fromCodePoint(text.codePointAt(b[k]!)!);
  while (k >= 0 && !inWord(char())) k--;
  while (k >= 0 && inWord(char())) k--;
  return b[k + 1]!;
}
function forward(text: string, i: number, inWord: (c: string) => boolean): number {
  const b = boundaries(text);
  let k = b.findIndex((x) => x >= i); // the character after `i` starts at b[k]
  const char = () => String.fromCodePoint(text.codePointAt(b[k]!)!);
  while (k < b.length - 1 && !inWord(char())) k++;
  while (k < b.length - 1 && inWord(char())) k++;
  return b[k]!;
}

// At 0 there is no line before: lastIndexOf would read -1 as 0 and find a line break there.
const lineStart = (text: string, i: number) => (i === 0 ? 0 : text.lastIndexOf("\n", i - 1) + 1);
const lineEnd = (text: string, i: number) => (text.indexOf("\n", i) + 1 || text.length + 1) - 1;

// One step: the text between `from` and `to` replaced. Typing joins the step before when that was
// typing too; everything else is a step of its own. A step that changes nothing is none.
function change(e: Editor, from: number, to: number, insert: string, how: { typing?: boolean; kill?: boolean } = {}): Editor {
  if (from === to && !insert) return { ...e, typing: false };
  const joins = how.typing === true && e.typing;
  return {
    text: e.text.slice(0, from) + insert + e.text.slice(to),
    cursor: from + insert.length,
    undo: joins ? e.undo : [...e.undo, { text: e.text, cursor: e.cursor }],
    typing: how.typing === true,
    killed: how.kill ? e.text.slice(from, to) : e.killed,
  };
}

const move = (e: Editor, cursor: number): Editor => ({ ...e, cursor, typing: false });

export function apply(e: Editor, a: Action): Editor {
  const { text, cursor: c } = e;
  if (typeof a === "object") return change(e, c, c, a.text, { typing: a.type === "insert" });
  switch (a) {
    case "newline":
      return change(e, c, c, "\n", { typing: true });
    case "left":
      return move(e, before(text, c));
    case "right":
      return move(e, after(text, c));
    case "home":
      return move(e, lineStart(text, c));
    case "end":
      return move(e, lineEnd(text, c));
    case "wordLeft":
      return move(e, back(text, c, wordChar));
    case "wordRight":
      return move(e, forward(text, c, wordChar));
    case "backspace":
      return change(e, before(text, c), c, "");
    case "delete":
      return change(e, c, after(text, c), "");
    case "deleteToSpace":
      return change(e, back(text, c, (ch) => !space(ch)), c, "", { kill: true });
    case "deleteWord":
      return change(e, back(text, c, wordChar), c, "", { kill: true });
    case "deleteWordAfter":
      return change(e, c, forward(text, c, wordChar), "", { kill: true });
    case "deleteToEnd": {
      const end = lineEnd(text, c);
      return change(e, c, end === c ? Math.min(text.length, c + 1) : end, "", { kill: true }); // at the end, the line break
    }
    case "deleteToStart": {
      const start = lineStart(text, c);
      return change(e, start === c ? Math.max(0, c - 1) : start, c, "", { kill: true });
    }
    case "yank":
      return change(e, c, c, e.killed);
    case "undo": {
      const last = e.undo.at(-1);
      return last ? { ...e, ...last, undo: e.undo.slice(0, -1), typing: false } : { ...e, typing: false };
    }
  }
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 29 passed | 2 skipped (31); Tests 451 passed | 7 skipped (458).

**Step 5: Commit**

```bash
git add src/tui/editor.ts tests/tui/editor.test.ts
git commit -m "feat: the prompt editor: moving, deleting, putting back and undo"
```

### Task 5: The prompt in screen rows, and Up and Down by row

`src/tui/layout.ts` (release 3 design, "Multi-line"): the prompt's text in the rows it takes on
screen, wrapped at the width, with wide characters counted as two columns by `string-width`. One
column is kept free so the cursor never wraps. `vertical()` moves the cursor one screen row up or
down, keeping to a goal column while the rows are long enough, and says when the cursor is on the
first or last row, where Up and Down reach the history instead.

**Files:**
- Modify: `package-lock.json`
- Modify: `package.json`
- Modify: `src/tui/editor.ts`
- Create: `src/tui/layout.ts`
- Create: `tests/tui/layout.test.ts`

**Step 1: Add string-width**

Run: `sfw npm install string-width@8.3.0 --save-exact --loglevel=http`

It is already installed under Ink; this makes it a direct dependency. If the install shows nothing
for a minute, stop it and run it again.

**Step 2: Write the failing tests**

**Create `tests/tui/layout.test.ts`:**

```ts
import { describe, expect, it } from "vitest";
import { layout, vertical } from "../../src/tui/layout.js";

describe("layout", () => {
  it("wraps the prompt at the width, by columns", () => {
    const l = layout("abcdef", 3);
    expect(l.rows).toEqual(["abc", "def"]);
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 }); // the cursor before "d" is where "d" is
    expect(l.places.get(6)).toEqual({ row: 1, col: 3 }); // after the last character, in the column left free
  });

  it("counts a wide character as two columns, and moves one that does not fit to the next row", () => {
    expect(layout("a中b", 3).rows).toEqual(["a中", "b"]);
    expect(layout("ab中", 3).rows).toEqual(["ab", "中"]);
    expect(layout("ab中", 3).places.get(2)).toEqual({ row: 1, col: 0 });
  });

  it("starts a row at each line break", () => {
    const l = layout("ab\ncd\n", 10);
    expect(l.rows).toEqual(["ab", "cd", ""]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 2 });
    expect(l.places.get(3)).toEqual({ row: 1, col: 0 });
    expect(l.places.get(6)).toEqual({ row: 2, col: 0 });
    expect(layout("", 10).rows).toEqual([""]);
  });

  it("shows control characters as escapes, as wide as they are shown", () => {
    const l = layout("a\u001bb\tc", 20);
    expect(l.rows).toEqual(["a\\u001bb⇥c"]);
    expect(l.places.get(2)).toEqual({ row: 0, col: 7 });
  });
});

describe("vertical", () => {
  it("moves one row up or down as the screen shows it, keeping the column", () => {
    expect(vertical("abcdef", 3, 4, -1, null)).toEqual({ cursor: 1, goal: 1 });
    expect(vertical("abcdef", 3, 2, 1, null)).toEqual({ cursor: 5, goal: 2 });
  });

  it("goes to the end of a shorter row, and back to the column it came from on a longer one", () => {
    const text = "abcdef\nx\nabcdef";
    const down = vertical(text, 10, 5, 1, null)!;
    expect(down).toEqual({ cursor: 8, goal: 5 }); // after the "x"
    expect(vertical(text, 10, down.cursor, 1, down.goal)).toEqual({ cursor: 14, goal: 5 });
  });

  it("says there is no row above the first or below the last, where the history starts", () => {
    expect(vertical("ab\ncd", 10, 1, -1, null)).toBeNull();
    expect(vertical("ab\ncd", 10, 4, 1, null)).toBeNull();
  });
});
```


**Step 3: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/layout.test.ts`

Expected: FAIL. In the scratch build: Test Files 1 failed (1), before any test runs. `src/tui/layout.ts` does not exist yet.

**Step 4: Write the code**

**Change `src/tui/editor.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/editor.ts b/src/tui/editor.ts
index be16ed4..297d46f 100644
--- a/src/tui/editor.ts
+++ b/src/tui/editor.ts
@@ -38,7 +38,7 @@ export function load(e: Editor, text: string): Editor {
   return { ...empty, text, cursor: text.length, killed: e.killed };
 }
 
-const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
+export const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
 
 // The places between characters as the screen shows them, so an emoji made of several code points
 // is passed over and deleted as one.
```

**Create `src/tui/layout.ts`:**

```ts
import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import { segmenter } from "./editor.js";

// The prompt as the screen shows it (release 3 design, "Multi-line"): rows of at most `width`
// columns, wrapped at the column, not at a word, and a new row at each line break. Control characters
// show as the escapes the scrollback uses, and take the columns those take. `width` leaves out the
// column the cursor needs after a full row, so a place is always on screen.

export interface Place {
  row: number;
  col: number;
}

export interface Layout {
  rows: string[]; // what each row shows
  places: Map<number, Place>; // every place between characters, by its index in the text
}

export function layout(text: string, width: number): Layout {
  const rows = [""];
  const places = new Map<number, Place>();
  let col = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (segment === "\n") {
      places.set(index, { row: rows.length - 1, col });
      rows.push("");
      col = 0;
      continue;
    }
    const shown = visible(segment);
    const w = stringWidth(shown);
    if (col > 0 && col + w > width) {
      rows.push("");
      col = 0;
    }
    places.set(index, { row: rows.length - 1, col }); // the place before a character is where it is drawn
    rows[rows.length - 1] += shown;
    col += w;
  }
  places.set(text.length, { row: rows.length - 1, col });
  return { rows, places };
}

// The cursor one row up (-1) or down (1), at the column `goal` (the column the moves started from),
// or at the end of a row too short for it. Null when there is no row there: Up and Down then step
// through the history instead.
export function vertical(text: string, width: number, cursor: number, dir: -1 | 1, goal: number | null): { cursor: number; goal: number } | null {
  const { places } = layout(text, width);
  const from = places.get(cursor)!;
  const row = from.row + dir;
  const aim = goal ?? from.col;
  let best: number | null = null;
  for (const [index, p] of places) {
    if (p.row !== row) continue;
    if (best === null || (p.col <= aim && p.col > places.get(best)!.col)) best = index;
  }
  return best === null ? null : { cursor: best, goal: aim };
}
```


**Step 5: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 30 passed | 2 skipped (32); Tests 458 passed | 7 skipped (465).

**Step 6: Commit**

```bash
git add package-lock.json package.json src/tui/editor.ts src/tui/layout.ts tests/tui/layout.test.ts
git commit -m "feat: the prompt in screen rows, and Up and Down by row"
```

### Task 6: The prompt's keys: line editing, new lines, pastes and the cursor

The editor goes on screen (release 3 design, "The keys" and "Multi-line"):
- **`src/tui/keys.ts`** turns what Ink's `useInput` reports into editor actions, for the codes the
  user's terminal was seen to send (main design, item 18). Choice 3 covers typed chunks.
- **`src/tui/Prompt.tsx`** draws the rows, "› " before the first, and places the terminal's own
  cursor with Ink's `useCursor`, so it shows where typing goes and input methods work.
- **App** keeps the editor in a ref, since several keys can arrive before the screen is drawn
  again. A paste (`usePaste`, which turns on bracketed paste) goes in whole and is never sent by its
  own line breaks. A backslash before Enter makes a new line in every terminal. Ink starts with the
  kitty keyboard protocol on "auto", which tells Shift+Enter from Enter where the terminal has it.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/tui/App.tsx`
- Create: `src/tui/Prompt.tsx`
- Modify: `src/tui/editor.ts`
- Create: `src/tui/keys.ts`
- Modify: `tests/tui/app.test.tsx`
- Create: `tests/tui/keys.test.ts`
- Create: `tests/tui/prompt.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index f89ce21..678eccb 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -547,3 +547,68 @@ describe("App", () => {
     expectNoRawControls(frame);
   });
 });
+
+// Each key in its own read of the terminal, as a person types them.
+async function press(app: ReturnType<typeof render>, ...keys: string[]) {
+  for (const k of keys) {
+    app.stdin.write(k);
+    await tick();
+  }
+}
+
+const sent = (session: Session) => session.messages[0]?.parts[0];
+
+describe("App's prompt", () => {
+  it("edits with the line-editing keys, and sends what they leave", async () => {
+    const { app, session } = await mount([reply("ok")]);
+    // Ctrl+W, Home, Ctrl+Right (to the end of "hello"), Alt+Backspace.
+    await press(app, "hello big world", "\u0017", "there", "\u001b[H", ">", "\u001b[1;5C", "\u001b\u007f", "hi");
+    expect(app.lastFrame()).toContain("› >hi big there");
+    await press(app, "\r");
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: ">hi big there" });
+  });
+
+  it("undoes a run of typing with Ctrl+Z", async () => {
+    const { app } = await mount([]);
+    await press(app, "one", "\u0017", "two", "\u001a");
+    expect(app.lastFrame()).toMatch(/^›$/m); // undo took back the typing after Ctrl+W
+    await press(app, "\u001a");
+    expect(app.lastFrame()).toContain("› one");
+  });
+
+  it("makes a new line with backslash and Enter, and with Ctrl+J, and sends the lines as one message", async () => {
+    const { app, session } = await mount([reply("ok")]);
+    await press(app, "one\\", "\r", "two", "\n", "three");
+    expect(app.lastFrame()).toContain("› one\n  two\n  three");
+    expect(session.messages).toEqual([]);
+    await press(app, "\r");
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: "one\ntwo\nthree" });
+  });
+
+  it("makes a new line on Shift+Enter where the terminal reports it apart from Enter", async () => {
+    const { app, session } = await mount([]);
+    await press(app, "one", "\u001b[13;2u", "two"); // Shift+Enter in the kitty keyboard protocol
+    expect(app.lastFrame()).toContain("› one\n  two");
+    expect(session.messages).toEqual([]);
+  });
+
+  it("takes a pasted block whole, without sending it at its line breaks", async () => {
+    const { app, session } = await mount([reply("ok")]);
+    await press(app, "\u001b[200~first line\rsecond line\u001b[201~");
+    expect(app.lastFrame()).toContain("› first line\n  second line");
+    expect(session.messages).toEqual([]);
+    await press(app, "\r");
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: "first line\nsecond line" });
+  });
+
+  it("wraps at the screen's width, leaving a column for the cursor, and moves up and down by screen row", async () => {
+    const { app } = await mount([]);
+    await press(app, "x".repeat(150)); // the test screen is 100 columns: "› " and 97 of them fit on a row
+    expect(app.lastFrame()).toContain(`› ${"x".repeat(97)}\n  ${"x".repeat(53)}`);
+    await press(app, "\u001b[A", "a", "\u001b[B", "b"); // up, then down again
+    expect(app.lastFrame()).toContain(`› ${"x".repeat(53)}a${"x".repeat(43)}\n  ${"x".repeat(54)}b`);
+  });
+});
```

**Create `tests/tui/keys.test.ts`:**

```ts
import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { commands } from "../../src/tui/keys.js";

// A key as Ink's useInput reports it: no flags but the ones given.
const key = (flags: Partial<Key> = {}): Key => ({
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
  ...flags,
});

describe("commands", () => {
  it("sends on Enter, and makes a new line on Shift+Enter where the terminal tells them apart", () => {
    expect(commands("\r", key({ return: true }))).toEqual(["submit"]);
    expect(commands("\r", key({ return: true, shift: true }))).toEqual(["newline"]);
  });

  it("makes a new line on Ctrl+J, which arrives as a line feed", () => {
    expect(commands("\n", key())).toEqual(["newline"]);
  });

  it("moves with the arrows, Home and End, Ctrl+A and Ctrl+E, and by word with Ctrl or Alt", () => {
    expect(commands("", key({ leftArrow: true }))).toEqual(["left"]);
    expect(commands("", key({ rightArrow: true }))).toEqual(["right"]);
    expect(commands("", key({ leftArrow: true, ctrl: true }))).toEqual(["wordLeft"]);
    expect(commands("", key({ rightArrow: true, ctrl: true }))).toEqual(["wordRight"]);
    expect(commands("", key({ home: true }))).toEqual(["home"]);
    expect(commands("", key({ end: true }))).toEqual(["end"]);
    expect(commands("a", key({ ctrl: true }))).toEqual(["home"]);
    expect(commands("e", key({ ctrl: true }))).toEqual(["end"]);
    expect(commands("b", key({ meta: true }))).toEqual(["wordLeft"]);
    expect(commands("f", key({ meta: true }))).toEqual(["wordRight"]);
    expect(commands("", key({ upArrow: true }))).toEqual(["up"]);
    expect(commands("", key({ downArrow: true }))).toEqual(["down"]);
  });

  it("deletes with the keys the user's terminal sends for them", () => {
    expect(commands("", key({ backspace: true }))).toEqual(["backspace"]); // Backspace, Ctrl+Backspace and Ctrl+H alike
    expect(commands("", key({ backspace: true, meta: true }))).toEqual(["deleteWord"]); // Alt+Backspace
    expect(commands("", key({ delete: true }))).toEqual(["delete"]);
    expect(commands("d", key({ ctrl: true }))).toEqual(["delete"]);
    expect(commands("w", key({ ctrl: true }))).toEqual(["deleteToSpace"]);
    expect(commands("d", key({ meta: true }))).toEqual(["deleteWordAfter"]);
    expect(commands("k", key({ ctrl: true }))).toEqual(["deleteToEnd"]);
    expect(commands("u", key({ ctrl: true }))).toEqual(["deleteToStart"]);
  });

  it("puts back with Ctrl+Y, and undoes with Ctrl+Z or Ctrl+_", () => {
    expect(commands("y", key({ ctrl: true }))).toEqual(["yank"]);
    expect(commands("z", key({ ctrl: true }))).toEqual(["undo"]);
    expect(commands("\u001f", key())).toEqual(["undo"]);
  });

  it("types text, and reads keys typed fast enough to arrive together one after another", () => {
    expect(commands("a", key())).toEqual([{ type: "insert", text: "a" }]);
    expect(commands("ab\rc", key())).toEqual([{ type: "insert", text: "ab" }, "submit", { type: "insert", text: "c" }]);
    expect(commands("a\nb", key())).toEqual([{ type: "insert", text: "a" }, "newline", { type: "insert", text: "b" }]);
  });

  it("does nothing for other keys and control characters", () => {
    expect(commands("q", key({ ctrl: true }))).toEqual([]);
    expect(commands("q", key({ meta: true }))).toEqual([]);
    expect(commands("", key({ tab: true }))).toEqual([]);
    expect(commands("", key({ escape: true }))).toEqual([]);
    expect(commands("a\u0007b", key())).toEqual([{ type: "insert", text: "ab" }]);
  });
});
```

**Create `tests/tui/prompt.test.tsx`:**

```tsx
import { EventEmitter } from "node:events";
import { render } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { load, empty } from "../../src/tui/editor.js";
import { Prompt } from "../../src/tui/Prompt.js";

// A stand-in terminal, which Ink draws to as to a real one, cursor moves included:
// ink-testing-library's leaves the cursor out.
class Terminal extends EventEmitter {
  isTTY = true;
  columns = 20;
  rows = 10;
  out = "";
  write = (s: string) => {
    this.out += s;
    return true;
  };
}

class Keyboard extends EventEmitter {
  isTTY = true;
  setRawMode() {}
  setEncoding() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => null;
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

describe("Prompt", () => {
  it("puts the terminal's cursor where typing goes, after the two columns each row starts with", async () => {
    const terminal = new Terminal();
    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} />;
    const app = render(at(2), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
    unmounts.push(app.unmount);
    await tick();
    // Up from below the prompt's two rows to the first, then to column 5: after "› ab".
    expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h");
    terminal.out = "";
    app.rerender(at(7));
    await tick();
    expect(terminal.out).toContain("\u001b[1A\u001b[5G\u001b[?25h"); // the second row, after "  ef"
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/prompt.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 6 failed | 40 passed (46). `src/tui/keys.ts` and `src/tui/Prompt.tsx` do not exist yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index a19d733..a84f14a 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -198,6 +198,7 @@ if (parsed.print !== undefined) {
         ask = fn;
       }}
     />,
-    { exitOnCtrlC: false },
+    // The kitty keyboard protocol, where the terminal has it, tells Shift+Enter from Enter.
+    { exitOnCtrlC: false, kittyKeyboard: { mode: "auto" } },
   );
 }
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 35acb1d..e51d515 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -1,4 +1,4 @@
-import { Static, Text, useApp, useInput } from "ink";
+import { Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
 import { useEffect, useRef, useState } from "react";
 import type { Bus, ErrorEvent } from "../core/bus.js";
 import { summarize } from "../core/errorlog.js";
@@ -8,7 +8,11 @@ import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
 import { describe, type Line, screen } from "./describe.js";
+import { apply, empty, load, move } from "./editor.js";
+import { type Command, commands } from "./keys.js";
+import { vertical } from "./layout.js";
 import { ModelPicker } from "./ModelPicker.js";
+import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
 
 type Question = { text: string; answer: (ok: boolean, how: string) => void };
@@ -36,7 +40,11 @@ const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgp
 export function App({ session, bus, stats, mode, project, gitBranch, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
-  const [input, setInput] = useState("");
+  // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
+  // screen is drawn again. `goal` is the column Up and Down keep to, until another key moves the cursor.
+  const editor = useRef(empty);
+  const goal = useRef<number | null>(null);
+  const { columns } = useWindowSize();
   const [busy, setBusy] = useState(false);
   const [question, setQuestion] = useState<Question | null>(null);
   const [contextWindow, setContextWindow] = useState<number | null>(null);
@@ -173,13 +181,41 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
     }
     if (key.ctrl && ch === "c") return busy ? abort.current?.abort() : exit();
     if (busy) return;
-    if (key.return) {
-      void submit(input);
-      setInput("");
-    } else if (key.backspace || key.delete) setInput((s) => s.slice(0, -1));
-    else if (!key.ctrl && !key.meta && ch) setInput((s) => s + ch);
+    for (const c of commands(ch, key)) run(c);
+    rerender((n) => n + 1);
   });
 
+  // A pasted block goes in whole, its line breaks as new lines: it is never sent by them. While the
+  // picker is open, pastes reach it as typed text, as before.
+  usePaste(
+    (text) => {
+      if (question || busy) return;
+      run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
+      rerender((n) => n + 1);
+    },
+    { isActive: !picker },
+  );
+
+  const run = (c: Command) => {
+    const e = editor.current;
+    if (c === "up" || c === "down") {
+      const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
+      if (to) {
+        editor.current = move(e, to.cursor);
+        goal.current = to.goal;
+      }
+      return;
+    }
+    goal.current = null;
+    if (c !== "submit") editor.current = apply(e, c);
+    // A backslash before Enter makes a new line in every terminal, in place of the backslash.
+    else if (e.text.slice(0, e.cursor).endsWith("\\")) editor.current = apply(apply(e, "backspace"), "newline");
+    else {
+      editor.current = load(e, "");
+      void submit(e.text);
+    }
+  };
+
   return (
     <>
       <Static items={lines}>
@@ -193,8 +229,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
         <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={() => setPicker(null)} />
       ) : question ? (
         <Text color="yellow">Allow {question.text}? [y/n]</Text>
+      ) : busy ? (
+        <Text>… working (Ctrl-C to stop)</Text>
       ) : (
-        <Text>{busy ? "… working (Ctrl-C to stop)" : `› ${input}`}</Text>
+        <Prompt editor={editor.current} columns={columns} />
       )}
       <StatusLine
         segments={segments}
```

**Create `src/tui/Prompt.tsx`:**

```tsx
import { Text, useCursor } from "ink";
import type { Editor } from "./editor.js";
import { layout } from "./layout.js";

// The columns the prompt's text may use: two go before it ("› " on the first row), and one after a
// full row is kept for the cursor.
export const promptWidth = (columns: number) => Math.max(1, columns - 3);

// The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
// where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
// drawn, Ink hides the cursor.
export function Prompt({ editor, columns }: { editor: Editor; columns: number }) {
  const { rows, places } = layout(editor.text, promptWidth(columns));
  const at = places.get(editor.cursor)!;
  useCursor().setCursorPosition({ x: 2 + at.col, y: at.row });
  return (
    <>
      {rows.map((row, i) => (
        <Text key={i}>
          {i ? "  " : "› "}
          {row}
        </Text>
      ))}
    </>
  );
}
```

**Change `src/tui/editor.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/editor.ts b/src/tui/editor.ts
index 297d46f..c718c16 100644
--- a/src/tui/editor.ts
+++ b/src/tui/editor.ts
@@ -89,7 +89,8 @@ function change(e: Editor, from: number, to: number, insert: string, how: { typi
   };
 }
 
-const move = (e: Editor, cursor: number): Editor => ({ ...e, cursor, typing: false });
+// The cursor somewhere else, which ends a run of typing. App moves it up and down by screen row.
+export const move = (e: Editor, cursor: number): Editor => ({ ...e, cursor, typing: false });
 
 export function apply(e: Editor, a: Action): Editor {
   const { text, cursor: c } = e;
```

**Create `src/tui/keys.ts`:**

```ts
import type { Key } from "ink";
import type { Action } from "./editor.js";

// What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
// user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
// needs the screen's width, so App does them.
export type Command = Action | "submit" | "up" | "down";

// Ink names a key held with Ctrl or Alt by its letter.
const CTRL: Record<string, Action> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo" };
const ALT: Record<string, Action> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };

export function commands(input: string, key: Key): Command[] {
  if (key.return) return [key.shift ? "newline" : "submit"]; // Shift+Enter only where the terminal tells it apart
  if (key.upArrow) return ["up"];
  if (key.downArrow) return ["down"];
  if (key.leftArrow) return [key.ctrl ? "wordLeft" : "left"];
  if (key.rightArrow) return [key.ctrl ? "wordRight" : "right"];
  if (key.home) return ["home"];
  if (key.end) return ["end"];
  // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
  if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
  if (key.delete) return ["delete"];
  if (key.ctrl) return CTRL[input] ? [CTRL[input]] : [];
  if (key.meta) return ALT[input] ? [ALT[input]] : [];
  if (input === "\u001f") return ["undo"]; // Ctrl+_
  // Typed text. Keys typed fast enough arrive together, Enter among them: a carriage return sends,
  // a line feed (Ctrl+J) makes a new line, and other control characters are dropped.
  return input.split(/(\r|\n)/).flatMap((part): Command[] => {
    if (part === "\r") return ["submit"];
    if (part === "\n") return ["newline"];
    const text = part.replace(/\p{Cc}/gu, "");
    return text ? [{ type: "insert", text }] : [];
  });
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 32 passed | 2 skipped (34); Tests 472 passed | 7 skipped (479).

**Step 5: Commit**

```bash
git add src/cli.tsx src/tui/App.tsx src/tui/Prompt.tsx src/tui/editor.ts src/tui/keys.ts tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/prompt.test.tsx
git commit -m "feat: the prompt's keys: line editing, new lines, pastes and the cursor"
```

### Task 7: Stopping and exiting, and the hint line

The design's "Stopping and exiting":
- **Esc during a turn** stops it, keeping what was done so far. **Esc at a question** declines that
  one action, and the turn goes on; the question now says "Esc to decline".
- **Ctrl-C** clears the prompt; on an empty one it asks for a second press, which exits. **Esc Esc**
  clears text (on an empty prompt it does nothing). **Ctrl-D** deletes the character after the
  cursor, and on an empty prompt asks for a second press.
- A second press counts within 800 ms; any other key in between starts the count again.
- **The hint line,** dim, between the prompt and the status line: "Press Ctrl-C again to exit" (or
  Ctrl-D: choice 4), else "? for shortcuts" while the prompt waits for the user.

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `tests/tui/app.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 678eccb..edbc038 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -612,3 +612,98 @@ describe("App's prompt", () => {
     expect(app.lastFrame()).toContain(`› ${"x".repeat(53)}a${"x".repeat(43)}\n  ${"x".repeat(54)}b`);
   });
 });
+
+// After an exit Ink reads no more keys, so a letter typed then never reaches the prompt.
+async function expectExited(app: ReturnType<typeof render>) {
+  await press(app, "x");
+  expect(app.lastFrame()).not.toContain("› x");
+}
+
+describe("App's keys for stopping and exiting", () => {
+  it("stops a turn on Esc, keeping what was done so far", async () => {
+    const { app } = await mount([], { lead: hanging() });
+    await type(app, "hi");
+    await until(app, "working");
+    await press(app, "\u001b");
+    await until(app, "›");
+    expect(app.lastFrame()).not.toContain("working");
+    expect(app.lastFrame()).toContain("> hi");
+  });
+
+  it("declines one action on Esc at a question, and the turn carries on", async () => {
+    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("carried on")]);
+    await type(app, "make a file");
+    const target = path.join(ctx.root, "a.txt");
+    await until(app, `Allow write ${target}? [y/n] · Esc to decline`);
+    await press(app, "\u001b");
+    await until(app, "carried on");
+    expect(app.lastFrame()).toContain(`write ${target}: declined`);
+    expect(existsSync(target)).toBe(false);
+  });
+
+  it("clears the prompt on Esc pressed twice, and not on one Esc or two with a key between", async () => {
+    const { app } = await mount([]);
+    await press(app, "abc", "\u001b");
+    expect(app.lastFrame()).toContain("› abc");
+    await press(app, "d", "\u001b");
+    expect(app.lastFrame()).toContain("› abcd");
+    await press(app, "\u001b");
+    expect(app.lastFrame()).toMatch(/^›$/m);
+    await press(app, "\u001b", "\u001b"); // on an empty prompt, nothing
+    expect(app.lastFrame()).toMatch(/^›$/m);
+  });
+
+  it("clears the prompt on Ctrl-C, and on an empty prompt asks for a second press, which exits", async () => {
+    const { app } = await mount([]);
+    await press(app, "abc", "\u0003");
+    expect(app.lastFrame()).toMatch(/^›$/m);
+    expect(app.lastFrame()).toContain("? for shortcuts");
+    await press(app, "\u0003");
+    expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
+    expect(app.lastFrame()).not.toContain("? for shortcuts");
+    await press(app, "\u0003");
+    await expectExited(app);
+  });
+
+  it("deletes the character after the cursor on Ctrl-D, and on an empty prompt asks for a second press, which exits", async () => {
+    const { app } = await mount([]);
+    await press(app, "ab", "\u001b[D", "\u0004");
+    expect(app.lastFrame()).toContain("› a\n");
+    await press(app, "\u0015", "\u0004"); // Ctrl+U empties the prompt
+    expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
+    await press(app, "\u0004");
+    await expectExited(app);
+  });
+
+  it("forgets a first press after 800 ms, and after any other key", async () => {
+    const { app } = await mount([]);
+    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
+    try {
+      const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
+      app.stdin.write("\u0003");
+      await wait(799);
+      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
+      await wait(1);
+      expect(app.lastFrame()).toContain("? for shortcuts");
+      app.stdin.write("\u0003");
+      await wait(10);
+      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit"); // a first press again, not an exit
+      app.stdin.write("\u0004"); // another key
+      await wait(10);
+      expect(app.lastFrame()).toContain("Press Ctrl-D again to exit");
+      app.stdin.write("\u0003");
+      await wait(10);
+      expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
+    } finally {
+      vi.useRealTimers();
+    }
+  });
+
+  it("shows the shortcuts hint only while the prompt waits for the user", async () => {
+    const { app } = await mount([], { lead: hanging() });
+    expect(app.lastFrame()).toContain("? for shortcuts");
+    await type(app, "hi");
+    await until(app, "working");
+    expect(app.lastFrame()).not.toContain("? for shortcuts");
+  });
+});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx`

Expected: FAIL. In the scratch build: Test Files 1 failed (1); Tests 7 failed | 46 passed (53). Esc does nothing yet, and Ctrl-C quits at once.

**Step 3: Write the code**

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index e51d515..18d184b 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -36,6 +36,7 @@ export interface AppProps {
 }
 
 const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
+const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
 
 export function App({ session, bus, stats, mode, project, gitBranch, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
@@ -44,6 +45,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
   // screen is drawn again. `goal` is the column Up and Down keep to, until another key moves the cursor.
   const editor = useRef(empty);
   const goal = useRef<number | null>(null);
+  const first = useRef<{ name: string; timer: NodeJS.Timeout } | null>(null); // a key waiting for its second press
   const { columns } = useWindowSize();
   const [busy, setBusy] = useState(false);
   const [question, setQuestion] = useState<Question | null>(null);
@@ -116,6 +118,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
     const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
     return () => {
       clearInterval(minutes);
+      clearTimeout(first.current?.timer);
       bus.off("message", onMessage);
       bus.off("error", onError);
       bus.off("usage", onUsage);
@@ -176,15 +179,40 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
       if (key.ctrl && ch === "c") {
         question.answer(false, "declined (cancelled)");
         abort.current?.abort();
-      } else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
+      } else if (key.escape) question.answer(false, "declined"); // that action only; the turn goes on
+      else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
       return;
     }
-    if (key.ctrl && ch === "c") return busy ? abort.current?.abort() : exit();
-    if (busy) return;
-    for (const c of commands(ch, key)) run(c);
+    const e = editor.current;
+    const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
+    if (busy) {
+      if (name === "Esc" || name === "Ctrl-C") abort.current?.abort();
+      return;
+    }
+    const again = name !== null && first.current?.name === name;
+    forget();
+    if (!name) for (const c of commands(ch, key)) run(c);
+    else if (name === "Ctrl-C" && e.text) editor.current = load(e, ""); // one press clears
+    else if (!again) remember(name);
+    else if (name !== "Esc") return exit();
+    else if (e.text) editor.current = load(e, ""); // Esc Esc; on an empty prompt it does nothing
     rerender((n) => n + 1);
   });
 
+  // Esc, Ctrl-C and Ctrl-D count twice when the second press comes within 800 ms of the first, the
+  // window Claude Code's docs give for Ctrl+D. Any other key in between starts the count again.
+  const remember = (name: string) => {
+    const timer = setTimeout(() => {
+      first.current = null;
+      rerender((n) => n + 1);
+    }, DOUBLE_PRESS_MS);
+    first.current = { name, timer };
+  };
+  const forget = () => {
+    clearTimeout(first.current?.timer);
+    first.current = null;
+  };
+
   // A pasted block goes in whole, its line breaks as new lines: it is never sent by them. While the
   // picker is open, pastes reach it as typed text, as before.
   usePaste(
@@ -216,6 +244,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
     }
   };
 
+  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies.
+  const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
+  const hint = exitKey ? `Press ${exitKey} again to exit` : !picker && !question && !busy ? "? for shortcuts" : null;
+
   return (
     <>
       <Static items={lines}>
@@ -228,12 +260,13 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
       {picker ? (
         <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={() => setPicker(null)} />
       ) : question ? (
-        <Text color="yellow">Allow {question.text}? [y/n]</Text>
+        <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
       ) : busy ? (
         <Text>… working (Ctrl-C to stop)</Text>
       ) : (
         <Prompt editor={editor.current} columns={columns} />
       )}
+      {hint && <Text dimColor>{hint}</Text>}
       <StatusLine
         segments={segments}
         info={{
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 32 passed | 2 skipped (34); Tests 479 passed | 7 skipped (486).

**Step 5: Commit**

```bash
git add src/tui/App.tsx tests/tui/app.test.tsx
git commit -m "feat: Esc stops a turn or declines one action; double presses clear and exit; a hint line"
```

### Task 8: Past prompts: Up and Down, and Ctrl+R

The design's "History", using Task 2's file:
- **Up** from the prompt's first row steps back through this project's past prompts, **Down** from
  its last row forward, and past the newest back to what was being typed. Ctrl+P and Ctrl+N do the
  same.
- **Ctrl+R** searches as you type, newest first. Ctrl+R again finds an older match, Enter sends the
  match, Tab or Esc puts it in the prompt to edit, and Ctrl-C, or Backspace with nothing searched
  for, gives back what was typed before: Claude Code's search keys (interactive-mode.md). Choice 5
  covers the rest.
- **Every sent prompt is saved,** and so is one cleared with Ctrl-C or Esc Esc. The same prompt twice
  in a row is kept once, as Claude Code keeps it.

App's tests share one history folder per test file, made private before the tests start: making a
new folder private takes about 1.5 s on Windows, which each test would otherwise pay.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/history.ts`
- Modify: `src/tui/keys.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/history.test.ts`
- Modify: `tests/tui/keys.test.ts`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index edbc038..2dfa018 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -1,14 +1,16 @@
-import { existsSync, writeFileSync } from "node:fs";
+import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
 import { mkdtemp } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import path from "node:path";
 import { render } from "ink-testing-library";
-import { afterEach, describe, expect, it, vi } from "vitest";
+import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
+import { privateDir } from "../../src/auth/private.js";
 import { PermissionGate } from "../../src/core/permissions.js";
 import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
 import { TOOLS } from "../../src/tools/index.js";
+import { History } from "../../src/tui/history.js";
 import type { ModelGroup } from "../../src/providers/models.js";
 import { App, type AppProps } from "../../src/tui/App.js";
 import { type Segment, SEGMENTS } from "../../src/tui/StatusLine.js";
@@ -29,9 +31,29 @@ afterEach(() => {
 
 type Login = AppProps["login"];
 
+// Each test's history is a file in one folder of this file's own, inside a fresh temp folder: the
+// history makes its folder private, which takes about 1.5 s for a new folder on Windows (measured
+// 2026-10-25), once a process.
+const histories = path.join(mkdtempSync(path.join(tmpdir(), "tachi-")), "history");
+mkdirSync(histories);
+beforeAll(() => privateDir(histories)); // so the first test does not wait for it
+let nextHistory = 0;
+
 async function mount(
   turns: ConstructorParameters<typeof FakeProvider>[1],
-  opts: { lead?: Provider; errorFile?: string; login?: Login; models?: ModelGroup[]; note?: string; slow?: boolean; made?: string[]; segments?: Segment[]; branches?: string[] } = {},
+  opts: {
+    lead?: Provider;
+    errorFile?: string;
+    login?: Login;
+    models?: ModelGroup[];
+    note?: string;
+    slow?: boolean;
+    made?: string[];
+    segments?: Segment[];
+    branches?: string[];
+    historyFile?: string;
+    past?: string[]; // the project's prompts from earlier sessions
+  } = {},
 ) {
   const bus = new Bus();
   const stats = new Stats(bus);
@@ -40,6 +62,8 @@ async function mount(
   const gate = new PermissionGate("ask", (s, d) => ask(s, d));
   const lead = opts.lead ?? new FakeProvider("a", turns);
   const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
+  const historyFile = opts.historyFile ?? path.join(histories, `${nextHistory++}.jsonl`);
+  if (opts.past) writeFileSync(historyFile, opts.past.map((p) => `${JSON.stringify(p)}\n`).join(""));
   const app = render(
     <App
       session={session}
@@ -48,6 +72,7 @@ async function mount(
       mode="ask"
       project="proj"
       gitBranch={() => opts.branches?.shift() ?? null}
+      historyFile={historyFile}
       errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
       segments={opts.segments ?? SEGMENTS}
       makeProvider={(spec) => {
@@ -67,7 +92,7 @@ async function mount(
   );
   mounted.push(app);
   await tick();
-  return { app, session, ctx, bus, ask: (s: string) => ask(s) };
+  return { app, session, ctx, bus, historyFile, ask: (s: string) => ask(s) };
 }
 
 async function type(app: ReturnType<typeof render>, text: string) {
@@ -707,3 +732,91 @@ describe("App's keys for stopping and exiting", () => {
     expect(app.lastFrame()).not.toContain("? for shortcuts");
   });
 });
+
+describe("App's history", () => {
+  it("steps back through the project's past prompts with Up, and forward again to what was being typed", async () => {
+    const { app } = await mount([], { past: ["old one", "old two"] });
+    await press(app, "draft", "\u001b[A");
+    expect(app.lastFrame()).toContain("› old two");
+    await press(app, "\u001b[A", "\u001b[A"); // and no further than the oldest
+    expect(app.lastFrame()).toContain("› old one");
+    await press(app, "\u001b[B");
+    expect(app.lastFrame()).toContain("› old two");
+    await press(app, "\u001b[B");
+    expect(app.lastFrame()).toContain("› draft");
+    await press(app, "\u0010"); // Ctrl+P, as Up
+    expect(app.lastFrame()).toContain("› old two");
+    await press(app, "\u000e"); // Ctrl+N, as Down
+    expect(app.lastFrame()).toContain("› draft");
+  });
+
+  it("moves through a prompt's rows first, and reaches the history from the first row", async () => {
+    const { app } = await mount([], { past: ["past"] });
+    await press(app, "a", "\n", "b", "\u001b[A", "x");
+    expect(app.lastFrame()).toContain("› ax\n  b");
+    await press(app, "\u001b[A");
+    expect(app.lastFrame()).toContain("› past");
+  });
+
+  it("saves each sent prompt, once when sent twice in a row, and one cleared with Ctrl-C or Esc Esc", async () => {
+    const { app, historyFile } = await mount([reply("r1"), reply("r2")]);
+    await type(app, "one");
+    await until(app, "r1");
+    await type(app, "  one ");
+    await until(app, "r2");
+    await press(app, "two", "\u0003", "three", "\u001b", "\u001b");
+    expect(new History(historyFile, () => {}).load()).toEqual(["one", "two", "three"]);
+    await press(app, "\u001b[A");
+    expect(app.lastFrame()).toContain("› three");
+  });
+
+  it("says once when the history cannot be read or saved, and still sends the prompt", async () => {
+    // A folder where the file should be, inside a folder of the test's own: the history makes its
+    // folder private, which must never be the system's temp folder.
+    const dir = path.join(await mkdtemp(path.join(tmpdir(), "tachi-")), "history.jsonl");
+    mkdirSync(dir);
+    const { app } = await mount([reply("still sent")], { historyFile: dir });
+    await until(app, "The prompt history could not be read or saved");
+    await type(app, "hi");
+    await until(app, "still sent");
+    expect(app.lastFrame()!.split("The prompt history could not").length).toBe(2);
+  });
+
+  it("searches the past prompts with Ctrl+R, an older match on each press, and puts one in the prompt on Tab", async () => {
+    const { app } = await mount([], { past: ["git status", "npm test", "git commit -m x", "ls"] });
+    await press(app, "\u0012", "git");
+    expect(app.lastFrame()).toContain("› git commit -m x");
+    expect(app.lastFrame()).toContain("search: git ·");
+    await press(app, "\u0012");
+    expect(app.lastFrame()).toContain("› git status");
+    await press(app, "\u0012"); // no older match: it stays
+    expect(app.lastFrame()).toContain("› git status");
+    await press(app, "\t", "!");
+    expect(app.lastFrame()).toContain("› git status!");
+    expect(app.lastFrame()).toContain("? for shortcuts");
+  });
+
+  it("sends the match on Enter, and puts it in the prompt on Esc", async () => {
+    const { app, session } = await mount([reply("ok")], { past: ["say hi", "say bye"] });
+    await press(app, "\u0012", "bye", "\u001b");
+    expect(app.lastFrame()).toContain("› say bye");
+    await press(app, "\u0015", "\u0012", "hi", "\r"); // Ctrl+U empties the prompt first
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: "say hi" });
+  });
+
+  it("gives back what was typed when the search is cancelled with Ctrl-C, or with Backspace on an empty search", async () => {
+    const { app } = await mount([], { past: ["say hi"] });
+    await press(app, "draft", "\u0012", "zz");
+    expect(app.lastFrame()).toContain("search: zz (no match)");
+    expect(app.lastFrame()).toContain("› draft");
+    await press(app, "\u0003");
+    expect(app.lastFrame()).toContain("› draft");
+    expect(app.lastFrame()).toContain("? for shortcuts");
+    await press(app, "\u0012", "h");
+    expect(app.lastFrame()).toContain("› say hi");
+    await press(app, "\u007f", "\u007f");
+    expect(app.lastFrame()).toContain("› draft");
+    expect(app.lastFrame()).not.toContain("search:");
+  });
+});
```

**Change `tests/tui/history.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/history.test.ts b/tests/tui/history.test.ts
index 306a1ca..d80ea81 100644
--- a/tests/tui/history.test.ts
+++ b/tests/tui/history.test.ts
@@ -4,7 +4,7 @@ import { tmpdir } from "node:os";
 import path from "node:path";
 import { pathToFileURL } from "node:url";
 import { describe, expect, it } from "vitest";
-import { History, historyFile } from "../../src/tui/history.js";
+import { History, historyFile, matches } from "../../src/tui/history.js";
 
 const temp = () => mkdtempSync(path.join(tmpdir(), "tachi-history-"));
 const historyUrl = pathToFileURL(path.resolve("src/tui/history.ts")).href;
@@ -73,3 +73,11 @@ describe("History", () => {
     expect(said).toEqual([`The prompt history could not be read or saved: ${file} is not a plain file, so it was not used`]);
   });
 });
+
+describe("matches", () => {
+  it("finds the past prompts holding the search, newest first, each once, in any case", () => {
+    expect(matches(["git status", "ls", "Git log", "git status"], "git")).toEqual(["git status", "Git log"]);
+    expect(matches(["a", "b"], "")).toEqual(["b", "a"]);
+    expect(matches(["a"], "z")).toEqual([]);
+  });
+});
```

**Change `tests/tui/keys.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/keys.test.ts b/tests/tui/keys.test.ts
index adc84dd..2268aa9 100644
--- a/tests/tui/keys.test.ts
+++ b/tests/tui/keys.test.ts
@@ -50,6 +50,12 @@ describe("commands", () => {
     expect(commands("f", key({ meta: true }))).toEqual(["wordRight"]);
     expect(commands("", key({ upArrow: true }))).toEqual(["up"]);
     expect(commands("", key({ downArrow: true }))).toEqual(["down"]);
+    expect(commands("p", key({ ctrl: true }))).toEqual(["up"]);
+    expect(commands("n", key({ ctrl: true }))).toEqual(["down"]);
+  });
+
+  it("searches the history with Ctrl+R", () => {
+    expect(commands("r", key({ ctrl: true }))).toEqual(["search"]);
   });
 
   it("deletes with the keys the user's terminal sends for them", () => {
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/history.test.ts tests/tui/keys.test.ts`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 10 failed | 64 passed | 1 skipped (75). Up and Ctrl+R do not reach the history yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index a84f14a..7b28e2c 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -20,6 +20,7 @@ import { createProvider } from "./providers/registry.js";
 import { TOOLS } from "./tools/index.js";
 import { App } from "./tui/App.js";
 import { gitBranch } from "./tui/git.js";
+import { historyFile } from "./tui/history.js";
 import { SEGMENTS } from "./tui/StatusLine.js";
 
 const HELP = `tachi: a coding agent for your terminal
@@ -189,6 +190,7 @@ if (parsed.print !== undefined) {
       mode={mode}
       project={path.basename(root) || root}
       gitBranch={() => gitBranch(root)}
+      historyFile={historyFile(root)}
       errorFile={errorFile}
       segments={segments}
       makeProvider={makeProvider}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 18d184b..4eed70f 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -1,14 +1,15 @@
-import { Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
+import { type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
 import { useEffect, useRef, useState } from "react";
 import type { Bus, ErrorEvent } from "../core/bus.js";
 import { summarize } from "../core/errorlog.js";
-import type { Mode } from "../core/permissions.js";
+import { type Mode, visible } from "../core/permissions.js";
 import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
 import { describe, type Line, screen } from "./describe.js";
-import { apply, empty, load, move } from "./editor.js";
+import { apply, type Editor, empty, load, move } from "./editor.js";
+import { History, matches } from "./history.js";
 import { type Command, commands } from "./keys.js";
 import { vertical } from "./layout.js";
 import { ModelPicker } from "./ModelPicker.js";
@@ -24,6 +25,7 @@ export interface AppProps {
   mode: Mode;
   project: string; // the project folder's name, for the status line
   gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
+  historyFile: string; // this project's past prompts
   errorFile: string;
   segments: Segment[];
   makeProvider: (spec: string) => Provider;
@@ -38,7 +40,7 @@ export interface AppProps {
 const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
 const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
 
-export function App({ session, bus, stats, mode, project, gitBranch, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, bus, stats, mode, project, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
@@ -46,6 +48,9 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
   const editor = useRef(empty);
   const goal = useRef<number | null>(null);
   const first = useRef<{ name: string; timer: NodeJS.Timeout } | null>(null); // a key waiting for its second press
+  const step = useRef<{ at: number; draft: string } | null>(null); // where Up has gone in the history, and what was typed before
+  // Ctrl+R: what is searched for, how many older matches Ctrl+R has passed, and the prompt to give back.
+  const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
   const { columns } = useWindowSize();
   const [busy, setBusy] = useState(false);
   const [question, setQuestion] = useState<Question | null>(null);
@@ -60,6 +65,8 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
   const lookups = useRef(0);
 
   const say = (...add: Line[]) => setLines((l) => [...l, ...add.map((x) => ({ ...screen(x), id: nextId.current++ }))]);
+  const history = useRef<History | null>(null);
+  history.current ??= new History(historyFile, (line) => say({ text: line, color: "magenta" }));
 
   // Only the latest lookup's answer is shown: a late one, for the previous lead or from before a
   // request, must not replace it. Asked again after each request, without clearing what is shown: a
@@ -114,6 +121,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
     bus.on("error", onError);
     bus.on("usage", onUsage);
     bus.on("lead", onLead);
+    history.current!.load();
     lookUpWindow();
     const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
     return () => {
@@ -183,6 +191,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
       else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
       return;
     }
+    if (search.current) {
+      searchKey(ch, key);
+      return rerender((n) => n + 1);
+    }
     const e = editor.current;
     const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
     if (busy) {
@@ -192,10 +204,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
     const again = name !== null && first.current?.name === name;
     forget();
     if (!name) for (const c of commands(ch, key)) run(c);
-    else if (name === "Ctrl-C" && e.text) editor.current = load(e, ""); // one press clears
+    else if (name === "Ctrl-C" && e.text) clear(e); // one press clears
     else if (!again) remember(name);
     else if (name !== "Esc") return exit();
-    else if (e.text) editor.current = load(e, ""); // Esc Esc; on an empty prompt it does nothing
+    else if (e.text) clear(e); // Esc Esc; on an empty prompt it does nothing
     rerender((n) => n + 1);
   });
 
@@ -217,7 +229,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
   // picker is open, pastes reach it as typed text, as before.
   usePaste(
     (text) => {
-      if (question || busy) return;
+      if (question || busy || search.current) return;
       run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
       rerender((n) => n + 1);
     },
@@ -231,22 +243,95 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
       if (to) {
         editor.current = move(e, to.cursor);
         goal.current = to.goal;
-      }
+      } else recall(c === "up" ? -1 : 1);
       return;
     }
     goal.current = null;
-    if (c !== "submit") editor.current = apply(e, c);
+    if (c === "search") {
+      search.current = { query: "", skip: 0, before: e };
+      step.current = null;
+    } else if (c !== "submit") editor.current = apply(e, c);
     // A backslash before Enter makes a new line in every terminal, in place of the backslash.
     else if (e.text.slice(0, e.cursor).endsWith("\\")) editor.current = apply(apply(e, "backspace"), "newline");
-    else {
-      editor.current = load(e, "");
-      void submit(e.text);
+    else send(e);
+  };
+
+  const send = (e: Editor) => {
+    keep(e.text);
+    editor.current = load(e, "");
+    void submit(e.text);
+  };
+  const clear = (e: Editor) => {
+    keep(e.text);
+    editor.current = load(e, "");
+  };
+  // Saved for Up and Ctrl+R, in this session and later ones: each sent prompt, and one cleared with
+  // Ctrl-C or Esc Esc. The same prompt twice in a row is kept once, as Claude Code keeps it.
+  const keep = (raw: string) => {
+    const text = raw.trim();
+    if (text && history.current!.entries.at(-1) !== text) void history.current!.add(text);
+    step.current = null;
+  };
+
+  // Up from the prompt's first row steps back through the history, Down from its last row forward,
+  // and past the newest prompt back to what was being typed. A prompt comes back with the cursor at
+  // its end.
+  const recall = (dir: -1 | 1) => {
+    const { entries } = history.current!;
+    const e = editor.current;
+    const at = (step.current?.at ?? entries.length) + dir;
+    goal.current = null;
+    if (at < 0 || (!step.current && dir === 1)) return;
+    if (at < entries.length) {
+      step.current = { at, draft: step.current?.draft ?? e.text };
+      editor.current = load(e, entries[at]!);
+    } else {
+      editor.current = load(e, step.current!.draft);
+      step.current = null;
+    }
+  };
+
+  // What the search shows in the prompt: the match, with the cursor at its end, or, with no match,
+  // the prompt as it was.
+  const shown = (): Editor => {
+    const s = search.current!;
+    const match = matches(history.current!.entries, s.query)[s.skip];
+    return match === undefined ? s.before : load(s.before, match);
+  };
+  const endSearch = (e: Editor) => {
+    search.current = null;
+    editor.current = e;
+  };
+  // Ctrl+R's keys, as Claude Code's search has them (interactive-mode.md): typing searches, Ctrl+R
+  // finds an older match, Enter sends the match, Tab or Esc puts it in the prompt to edit, and Ctrl-C,
+  // or Backspace with nothing searched for, gives back what was typed before.
+  const searchKey = (ch: string, key: Key) => {
+    const s = search.current!;
+    if (key.ctrl && ch === "c") return endSearch(s.before);
+    if (key.tab || key.escape) return endSearch(shown());
+    for (const c of commands(ch, key)) {
+      if (typeof c === "object") Object.assign(s, { query: s.query + c.text, skip: 0 });
+      else if (c === "search") s.skip = Math.max(0, Math.min(s.skip + 1, matches(history.current!.entries, s.query).length - 1));
+      else if (c === "backspace" && !s.query) return endSearch(s.before);
+      else if (c === "backspace") Object.assign(s, { query: [...s.query].slice(0, -1).join(""), skip: 0 });
+      else if (c === "submit") {
+        const e = shown();
+        endSearch(e);
+        return send(e);
+      }
     }
   };
 
   // The hint line, under the prompt (release 3 design, "On screen"): whichever applies.
   const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
-  const hint = exitKey ? `Press ${exitKey} again to exit` : !picker && !question && !busy ? "? for shortcuts" : null;
+  const searching = search.current && `search: ${visible(search.current.query)}${shown() === search.current.before ? " (no match)" : ""}`;
+  const hint = searching
+    ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
+    : exitKey
+      ? `Press ${exitKey} again to exit`
+      : !picker && !question && !busy
+        ? "? for shortcuts"
+        : null;
 
   return (
     <>
@@ -264,7 +349,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, errorFile,
       ) : busy ? (
         <Text>… working (Ctrl-C to stop)</Text>
       ) : (
-        <Prompt editor={editor.current} columns={columns} />
+        <Prompt editor={search.current ? shown() : editor.current} columns={columns} />
       )}
       {hint && <Text dimColor>{hint}</Text>}
       <StatusLine
```

**Change `src/tui/history.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/history.ts b/src/tui/history.ts
index c374b6c..941167b 100644
--- a/src/tui/history.ts
+++ b/src/tui/history.ts
@@ -31,6 +31,13 @@ function parse(text: string): string[] {
   });
 }
 
+// Ctrl+R's matches: the past prompts holding `query`, in any case as the model picker's filter, newest
+// first, each prompt once, at its newest (as Claude Code's search, interactive-mode.md).
+export function matches(entries: readonly string[], query: string): string[] {
+  const q = query.toLowerCase();
+  return [...new Set(entries.toReversed())].filter((e) => e.toLowerCase().includes(q));
+}
+
 export class History {
   // Oldest first: what was saved before this session, then this session's prompts.
   readonly entries: string[] = [];
```

**Change `src/tui/keys.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/keys.ts b/src/tui/keys.ts
index f46a8b7..a4894ec 100644
--- a/src/tui/keys.ts
+++ b/src/tui/keys.ts
@@ -4,10 +4,11 @@ import type { Action } from "./editor.js";
 // What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
 // user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
 // needs the screen's width, so App does them.
-export type Command = Action | "submit" | "up" | "down";
+export type Command = Action | "submit" | "up" | "down" | "search";
 
 // Ink names a key held with Ctrl or Alt by its letter.
-const CTRL: Record<string, Action> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo" };
+// Ctrl+P and Ctrl+N are Up and Down, as in Claude Code.
+const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search" };
 const ALT: Record<string, Action> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };
 
 export function commands(input: string, key: Key): Command[] {
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 32 passed | 2 skipped (34); Tests 488 passed | 7 skipped (495).

**Step 5: Commit**

```bash
git add src/cli.tsx src/tui/App.tsx src/tui/history.ts src/tui/keys.ts tests/tui/app.test.tsx tests/tui/history.test.ts tests/tui/keys.test.ts
git commit -m "feat: the prompt history: Up and Down through past prompts, and Ctrl+R to search them"
```

### Task 9: Typing while it works: the queue

The design's "Typing while it works":
- **The prompt stays editable during a turn.** Enter adds what is typed to the queue, shown grey
  under the working line.
- **When a turn ends,** however it ended, entries are taken from the front: prompts next to each
  other as one message, separated by blank lines; a `/command` alone, as if typed then. A queued
  `/model` waits until the list is closed. `/exit` empties the queue. The queue never moves while
  something runs: typed in one read of the terminal, `/lead x`, Enter, `one`, Enter, `two`, Enter
  starts `one` before `/lead` has finished, and `two` waits for `one`.
- **Ctrl-C during a turn, or at a question,** stops it and brings the queue back into the prompt,
  one entry a line, after any text already there. **Up on an empty prompt** does the same.

`Prompt` takes `offset`, the rows drawn above it, because Ink places the cursor from the top of its
own output. Choice 6 covers the rest.

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/Prompt.tsx`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/prompt.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 2dfa018..b539823 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -24,6 +24,12 @@ async function until(app: ReturnType<typeof render>, text: string) {
   expect(app.lastFrame()).toContain(text);
 }
 
+// Wait until the screen no longer shows `text`.
+async function gone(app: ReturnType<typeof render>, text: string) {
+  for (let i = 0; i < 40 && app.lastFrame()?.includes(text); i++) await tick();
+  expect(app.lastFrame()).not.toContain(text);
+}
+
 const mounted: ReturnType<typeof render>[] = [];
 afterEach(() => {
   for (const app of mounted.splice(0)) app.unmount();
@@ -53,6 +59,7 @@ async function mount(
     branches?: string[];
     historyFile?: string;
     past?: string[]; // the project's prompts from earlier sessions
+    newLead?: Provider; // what /lead and the picker make
   } = {},
 ) {
   const bus = new Bus();
@@ -77,7 +84,7 @@ async function mount(
       segments={opts.segments ?? SEGMENTS}
       makeProvider={(spec) => {
         opts.made?.push(spec);
-        return new FakeProvider("b", []);
+        return opts.newLead ?? new FakeProvider("b", []);
       }}
       login={opts.login ?? (async () => {})}
       listModels={async (signal, warn) => {
@@ -161,8 +168,7 @@ describe("App", () => {
     await until(app, `Allow write ${target}? [y/n]`);
     app.stdin.write("\u0003");
     await until(app, `write ${target}: declined (cancelled)`);
-    await until(app, "›");
-    expect(app.lastFrame()).not.toContain("working");
+    await gone(app, "working");
     expect(app.lastFrame()).not.toContain("[y/n]");
     expect(app.lastFrame()).not.toContain("written");
     expect(existsSync(target)).toBe(false);
@@ -173,8 +179,7 @@ describe("App", () => {
     await type(app, "hi");
     await until(app, "working");
     app.stdin.write("\u0003");
-    await until(app, "›");
-    expect(app.lastFrame()).not.toContain("working");
+    await gone(app, "working");
     const answer = await Promise.race([ask("write x"), tick().then(() => "still waiting")]);
     expect(answer).toBe(false);
     expect(app.lastFrame()).not.toContain("[y/n]");
@@ -274,7 +279,7 @@ describe("App", () => {
     await until(app, "working");
     app.stdin.write("\u0003");
     await until(app, "Sign-in was cancelled");
-    await until(app, "›");
+    await gone(app, "working");
   });
 
   const models: ModelGroup[] = [
@@ -405,7 +410,7 @@ describe("App", () => {
     await type(app, "/model");
     await until(app, "Ctrl-C to stop");
     app.stdin.write("\u0003");
-    await until(app, "›");
+    await gone(app, "Ctrl-C to stop");
     await tick();
     expect(app.lastFrame()).not.toContain("fake:c");
     expect(app.lastFrame()).not.toContain("Filter:");
@@ -650,8 +655,7 @@ describe("App's keys for stopping and exiting", () => {
     await type(app, "hi");
     await until(app, "working");
     await press(app, "\u001b");
-    await until(app, "›");
-    expect(app.lastFrame()).not.toContain("working");
+    await gone(app, "working");
     expect(app.lastFrame()).toContain("> hi");
   });
 
@@ -820,3 +824,169 @@ describe("App's history", () => {
     expect(app.lastFrame()).not.toContain("search:");
   });
 });
+
+// A lead that answers in turn, the first request only once `release` is called (or Esc stops it).
+function gated(turns: ConstructorParameters<typeof FakeProvider>[1]) {
+  const fake = new FakeProvider("a", turns);
+  let release!: () => void;
+  const open = new Promise<void>((resolve) => (release = resolve));
+  let first = true;
+  const lead: Provider = {
+    id: fake.id,
+    complete: async (req) => {
+      if (first) {
+        first = false;
+        await new Promise<void>((resolve, reject) => {
+          void open.then(resolve);
+          req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
+        });
+      }
+      return fake.complete(req);
+    },
+  };
+  return { lead, fake, release };
+}
+
+// The user's messages, in the order the model was sent them.
+const prompts = (session: Session) => session.messages.filter((m) => m.role === "user").flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])));
+
+describe("App's queue", () => {
+  it("keeps the prompt open during a turn, queues each Enter under the working line, and sends prompts next to each other as one", async () => {
+    const { lead, release } = gated([reply("r1"), reply("r2")]);
+    const { app, session, historyFile } = await mount([], { lead });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "two", "\r", "three", "\r", "fo");
+    expect(app.lastFrame()).toMatch(/working[^\n]*\ntwo\nthree\n› fo\n↑ to edit queued messages\n/);
+    release();
+    await until(app, "r2");
+    expect(prompts(session)).toEqual(["one", "two\n\nthree"]);
+    expect(app.lastFrame()).toContain("› fo");
+    expect(app.lastFrame()).not.toContain("queued");
+    expect(new History(historyFile, () => {}).load()).toEqual(["one", "two", "three"]); // saved as each was added
+  });
+
+  it("queues a prompt typed straight after another, in one read of the terminal", async () => {
+    const { lead, release } = gated([reply("r1"), reply("r2")]);
+    const { app, session } = await mount([], { lead });
+    app.stdin.write("one\rtwo\r");
+    await until(app, "working");
+    expect(app.lastFrame()).toMatch(/working[^\n]*\ntwo\n›/);
+    release();
+    await until(app, "r2");
+    expect(prompts(session)).toEqual(["one", "two"]);
+  });
+
+  it("keeps the queue waiting for a turn started straight after a command, in one read of the terminal", async () => {
+    const { lead, release } = gated([reply("r1"), reply("r2")]);
+    const { app, session } = await mount([], { lead, newLead: lead });
+    app.stdin.write("/lead fake:b\rone\rtwo\r");
+    await tick(); // the command is done, and its turn-end would take the queue on
+    expect(app.lastFrame()).toMatch(/\ntwo\n›/); // still queued: one is running
+    release();
+    await until(app, "r2");
+    expect(prompts(session)).toEqual(["one", "two"]);
+  });
+
+  it("takes a /command alone, as if typed then, and the prompts after it wait until it is done", async () => {
+    const { lead, fake, release } = gated([reply("r1"), reply("r2")]);
+    const b = new FakeProvider("b", [reply("from b")]);
+    const { app, session } = await mount([], { lead, newLead: b });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "two", "\r", "/lead fake:b", "\r", "three", "\r");
+    release();
+    await until(app, "from b");
+    expect(prompts(session)).toEqual(["one", "two", "three"]);
+    expect(fake.seen).toHaveLength(2);
+    expect(b.seen).toHaveLength(1);
+    expect(app.lastFrame()).toMatch(/r2[\s\S]*lead is now fake:b[\s\S]*> three/);
+  });
+
+  it("goes on with the queue after Esc stops a turn, and after a turn that ends in an error", async () => {
+    const { lead, release } = gated([new Error("boom"), reply("last")]);
+    const { app, session } = await mount([], { lead });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "two", "\r", "/lead", "\r", "three", "\r", "\u001b");
+    await until(app, "last");
+    release();
+    expect(prompts(session)).toEqual(["one", "two", "three"]);
+    expect(app.lastFrame()).toMatch(/boom[\s\S]*Usage: \/lead[\s\S]*> three/);
+  });
+
+  it("brings the queue back into the prompt on Ctrl-C, after what is typed, one entry a line, and sends nothing more", async () => {
+    const { app, session } = await mount([], { lead: hanging() });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "two", "\r", "three", "\r", "draft", "\u0003");
+    await gone(app, "working");
+    expect(app.lastFrame()).toContain("› draft\n  two\n  three\n? for shortcuts");
+    await tick();
+    expect(prompts(session)).toEqual(["one"]);
+  });
+
+  it("brings the queue back on Ctrl-C at a question too", async () => {
+    const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" })]);
+    const { app, ctx } = await mount([], { lead });
+    await type(app, "make a file");
+    await until(app, "working");
+    await press(app, "two", "\r");
+    release();
+    await until(app, `Allow write ${path.join(ctx.root, "a.txt")}?`);
+    await press(app, "\u0003");
+    await gone(app, "working");
+    expect(app.lastFrame()).toContain("› two\n? for shortcuts");
+  });
+
+  it("exits on a queued /exit, sending nothing after it", async () => {
+    const { lead, release } = gated([reply("r1"), reply("r2")]);
+    const { app, session } = await mount([], { lead });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "/exit", "\r", "two", "\r");
+    release();
+    await vi.waitFor(() => expect(session.messages.at(-1)?.role).toBe("assistant")); // the screen is gone once it exits
+    await tick();
+    expect(prompts(session)).toEqual(["one"]);
+    await expectExited(app);
+  });
+
+  it("shows the queue's hint only while the prompt has the keys", async () => {
+    const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("done")]);
+    const { app } = await mount([], { lead });
+    await type(app, "make a file");
+    await until(app, "working");
+    await press(app, "two", "\r");
+    expect(app.lastFrame()).toContain("↑ to edit queued messages");
+    release();
+    await until(app, "[y/n]");
+    expect(app.lastFrame()).not.toContain("queued");
+  });
+
+  it("waits after a queued /model until the list is closed", async () => {
+    const { lead, release } = gated([reply("r1"), reply("r2")]);
+    const { app, session } = await mount([], { lead, models: [{ provider: "fake", models: ["a", "c"] }] });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "/model", "\r", "two", "\r");
+    release();
+    await until(app, "fake:c");
+    await tick();
+    expect(prompts(session)).toEqual(["one"]);
+    await press(app, "\u001b");
+    await until(app, "r2");
+    expect(prompts(session)).toEqual(["one", "two"]);
+  });
+
+  it("takes the queue back on Up from an empty prompt", async () => {
+    const { app } = await mount([], { lead: hanging(), past: ["old"] });
+    await type(app, "one");
+    await until(app, "working");
+    await press(app, "two", "\r", "three", "\r", "\u001b[A");
+    expect(app.lastFrame()).toContain("› two\n  three\n");
+    expect(app.lastFrame()).not.toContain("queued");
+    await press(app, "\u001b[A", "\u001b[A"); // the prompt has text now: Up moves up its rows, then into the history
+    expect(app.lastFrame()).toContain("› three");
+  });
+});
```

**Change `tests/tui/prompt.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/prompt.test.tsx b/tests/tui/prompt.test.tsx
index bbe4ed5..50498ec 100644
--- a/tests/tui/prompt.test.tsx
+++ b/tests/tui/prompt.test.tsx
@@ -1,5 +1,5 @@
 import { EventEmitter } from "node:events";
-import { render } from "ink";
+import { render, Text } from "ink";
 import { afterEach, describe, expect, it } from "vitest";
 import { load, empty } from "../../src/tui/editor.js";
 import { Prompt } from "../../src/tui/Prompt.js";
@@ -37,7 +37,7 @@ afterEach(() => {
 describe("Prompt", () => {
   it("puts the terminal's cursor where typing goes, after the two columns each row starts with", async () => {
     const terminal = new Terminal();
-    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} />;
+    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} offset={0} />;
     const app = render(at(2), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
     unmounts.push(app.unmount);
     await tick();
@@ -48,4 +48,19 @@ describe("Prompt", () => {
     await tick();
     expect(terminal.out).toContain("\u001b[1A\u001b[5G\u001b[?25h"); // the second row, after "  ef"
   });
+
+  it("counts the rows above it, which the cursor is placed from", async () => {
+    const terminal = new Terminal();
+    const tree = (
+      <>
+        <Text>working</Text>
+        <Text>queued</Text>
+        <Prompt editor={{ ...load(empty, "abcd\nef"), cursor: 2 }} columns={terminal.columns} offset={2} />
+      </>
+    );
+    const app = render(tree, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
+    unmounts.push(app.unmount);
+    await tick();
+    expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h"); // up from below the four rows to the third
+  });
 });
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/prompt.test.tsx`

Expected: FAIL. In the scratch build: Test Files 2 failed (2); Tests 12 failed | 61 passed (73). Enter during a turn is ignored yet.

**Step 3: Write the code**

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 4eed70f..d88cf80 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -40,6 +40,11 @@ export interface AppProps {
 const COMMANDS = "/lead <provider:model>, /model, /login chatgpt, /logout chatgpt, /errors, /exit";
 const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (interactive-mode.md)
 
+// What submit takes as a command: a command's name first, or a slash and a bare word ("/tmp is full"
+// is a message).
+const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
+const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
+
 export function App({ session, bus, stats, mode, project, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
@@ -53,6 +58,8 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
   const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
   const { columns } = useWindowSize();
   const [busy, setBusy] = useState(false);
+  const working = useRef(false); // busy, for keys read before the screen is drawn again
+  const queue = useRef<string[]>([]); // what Enter added during a turn, in order
   const [question, setQuestion] = useState<Question | null>(null);
   const [contextWindow, setContextWindow] = useState<number | null>(null);
   const [picker, setPicker] = useState<ModelGroup[] | null>(null);
@@ -134,8 +141,24 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     };
   }, []);
 
-  // Called without await, so nothing may escape: an unhandled rejection ends the program.
+  // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
+  // goes on after a turn, however it ended, and after `/model` once the list is closed.
   const submit = async (raw: string) => {
+    if (!(await perform(raw))) next();
+  };
+
+  // Entries are taken from the front: a command alone, as if typed then; prompts next to each other
+  // as one message, separated by blank lines. Not while something runs: a command that finished
+  // after a turn started (both typed in one read of the terminal) leaves the queue to that turn.
+  const next = () => {
+    if (working.current) return;
+    const q = queue.current;
+    const command = q.findIndex(isCommand);
+    if (q.length) void submit(q.splice(0, command === 0 ? 1 : command === -1 ? q.length : command).join("\n\n"));
+  };
+
+  // True when it opened the model list.
+  const perform = async (raw: string): Promise<boolean | void> => {
     const text = raw.trim();
     if (!text) return;
     // Commands ignore case; a message is sent as typed.
@@ -143,7 +166,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     const command = first.toLowerCase();
     const alone = (name: string) => command === name && !words.length;
     try {
-      if (alone("/exit")) return exit();
+      if (alone("/exit")) {
+        queue.current = [];
+        return exit();
+      }
       if (alone("/errors")) return say(...summarize(errorFile).map((row) => ({ text: row, oneLine: true })));
       if (alone("/lead")) return say({ text: "Usage: /lead <provider:model>" });
       if (command === "/lead") return session.setLead(makeProvider(words.join(" ")));
@@ -154,16 +180,21 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
       if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
       abort.current = new AbortController();
       setBusy(true);
+      working.current = true;
       try {
         // Signing in waits on the browser; Ctrl-C stops it, as it stops a turn.
         if (account) await login(account, words, (line) => say({ text: line, color: "magenta" }), abort.current.signal, "/");
         else if (alone("/model")) {
           const { signal } = abort.current; // this command's own, read before the wait
           const groups = await listModels(signal, (line) => say({ text: line, color: "magenta" }));
-          if (!signal.aborted) setPicker(groups);
+          if (!signal.aborted) {
+            setPicker(groups);
+            return true;
+          }
         } else await session.send(text, abort.current.signal);
       } finally {
         setBusy(false);
+        working.current = false;
         setBranch(gitBranch());
       }
     } catch (err) {
@@ -179,6 +210,11 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     } catch (err) {
       say({ text: errorText(err), color: "red" });
     }
+    next();
+  };
+  const closePicker = () => {
+    setPicker(null);
+    next();
   };
 
   useInput((ch, key) => {
@@ -187,6 +223,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
       if (key.ctrl && ch === "c") {
         question.answer(false, "declined (cancelled)");
         abort.current?.abort();
+        restore();
       } else if (key.escape) question.answer(false, "declined"); // that action only; the turn goes on
       else if (ch === "y" || ch === "n") question.answer(ch === "y", ch === "y" ? "allowed" : "declined");
       return;
@@ -197,9 +234,12 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     }
     const e = editor.current;
     const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
-    if (busy) {
-      if (name === "Esc" || name === "Ctrl-C") abort.current?.abort();
-      return;
+    // During a turn the prompt still edits; Esc stops the turn and the queue goes on, Ctrl-C stops it
+    // and the queue comes back. Ctrl-D does not exit while a turn is running.
+    if (working.current && name) {
+      if (name === "Ctrl-C") restore();
+      if (name !== "Ctrl-D") abort.current?.abort();
+      return rerender((n) => n + 1);
     }
     const again = name !== null && first.current?.name === name;
     forget();
@@ -229,7 +269,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
   // picker is open, pastes reach it as typed text, as before.
   usePaste(
     (text) => {
-      if (question || busy || search.current) return;
+      if (question || search.current) return;
       run({ type: "paste", text: text.replace(/\r\n?/g, "\n") });
       rerender((n) => n + 1);
     },
@@ -238,6 +278,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
 
   const run = (c: Command) => {
     const e = editor.current;
+    if (c === "up" && !e.text && queue.current.length) return restore();
     if (c === "up" || c === "down") {
       const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
       if (to) {
@@ -259,7 +300,15 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
   const send = (e: Editor) => {
     keep(e.text);
     editor.current = load(e, "");
-    void submit(e.text);
+    if (!working.current) void submit(e.text);
+    else if (e.text.trim()) queue.current.push(e.text.trim());
+  };
+  // Ctrl-C during a turn, or Up on an empty prompt: the queue comes back into the prompt, one entry a
+  // line, after what is there, to edit or send.
+  const restore = () => {
+    if (!queue.current.length) return;
+    editor.current = load(editor.current, [editor.current.text, ...queue.current].filter(Boolean).join("\n"));
+    queue.current = [];
   };
   const clear = (e: Editor) => {
     keep(e.text);
@@ -329,9 +378,13 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
     : exitKey
       ? `Press ${exitKey} again to exit`
-      : !picker && !question && !busy
-        ? "? for shortcuts"
-        : null;
+      : picker || question
+        ? null
+        : queue.current.length
+          ? "↑ to edit queued messages"
+          : busy
+            ? null
+            : "? for shortcuts";
 
   return (
     <>
@@ -343,13 +396,19 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
         )}
       </Static>
       {picker ? (
-        <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={() => setPicker(null)} />
+        <ModelPicker groups={picker} current={session.lead.id} onPick={pick} onClose={closePicker} />
       ) : question ? (
         <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
-      ) : busy ? (
-        <Text>… working (Ctrl-C to stop)</Text>
       ) : (
-        <Prompt editor={search.current ? shown() : editor.current} columns={columns} />
+        <>
+          {busy && <Text>… working (Ctrl-C to stop)</Text>}
+          {queue.current.map((q, i) => (
+            <Text key={i} color="gray" wrap="truncate-end">
+              {visible(q)}
+            </Text>
+          ))}
+          <Prompt editor={search.current ? shown() : editor.current} columns={columns} offset={(busy ? 1 : 0) + queue.current.length} />
+        </>
       )}
       {hint && <Text dimColor>{hint}</Text>}
       <StatusLine
```

**Change `src/tui/Prompt.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/Prompt.tsx b/src/tui/Prompt.tsx
index e3a8319..d310285 100644
--- a/src/tui/Prompt.tsx
+++ b/src/tui/Prompt.tsx
@@ -8,11 +8,12 @@ export const promptWidth = (columns: number) => Math.max(1, columns - 3);
 
 // The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
 // where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
-// drawn, Ink hides the cursor.
-export function Prompt({ editor, columns }: { editor: Editor; columns: number }) {
+// drawn, Ink hides the cursor. `offset` is the rows drawn above it, since Ink places the cursor from
+// the top of what it draws.
+export function Prompt({ editor, columns, offset }: { editor: Editor; columns: number; offset: number }) {
   const { rows, places } = layout(editor.text, promptWidth(columns));
   const at = places.get(editor.cursor)!;
-  useCursor().setCursorPosition({ x: 2 + at.col, y: at.row });
+  useCursor().setCursorPosition({ x: 2 + at.col, y: offset + at.row });
   return (
     <>
       {rows.map((row, i) => (
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 32 passed | 2 skipped (34); Tests 500 passed | 7 skipped (507).

**Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/Prompt.tsx tests/tui/app.test.tsx tests/tui/prompt.test.tsx
git commit -m "feat: typing while it works: Enter queues, the queue runs after each turn, Ctrl-C and Up bring it back"
```

### Task 10: The prompt's space

The design's "The prompt's space". The live part of the screen stays at least one row shorter than
the terminal, since at full height Ink clears the terminal and prints the whole scrollback again on
every redraw. Its rows go to the status line and the working line first, then the hint line when it
and the cursor's row fit, then the prompt, then the queue.
- **A prompt taller than its space** shows a window of rows that keeps the cursor's row in view and
  moves only as the cursor needs (`scroll()` in `layout.ts`), the first or last row saying how many
  rows are above or below.
- **The queue** gets what is left, its last row saying "+N more"; with no row left, the hint line
  says "N queued".

The App tests now give ink-testing-library's terminal a height (24 rows unless a test sets one).
Choice 7 covers the rest.

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/Prompt.tsx`
- Modify: `src/tui/layout.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/layout.test.ts`
- Modify: `tests/tui/prompt.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index b539823..9c8ce3c 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -60,6 +60,7 @@ async function mount(
     historyFile?: string;
     past?: string[]; // the project's prompts from earlier sessions
     newLead?: Provider; // what /lead and the picker make
+    rows?: number; // the terminal's height
   } = {},
 ) {
   const bus = new Bus();
@@ -98,6 +99,9 @@ async function mount(
     />,
   );
   mounted.push(app);
+  // ink-testing-library's terminal has no height; 24 rows is Ink's own default size (getWindowSize).
+  Object.assign(app.stdout, { rows: opts.rows ?? 24 });
+  app.stdout.emit("resize");
   await tick();
   return { app, session, ctx, bus, historyFile, ask: (s: string) => ask(s) };
 }
@@ -708,7 +712,11 @@ describe("App's keys for stopping and exiting", () => {
     const { app } = await mount([]);
     vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
     try {
-      const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);
+      // Then one turn of the event loop (setImmediate is not faked), in which the screen is drawn again.
+      const wait = async (ms: number) => {
+        await vi.advanceTimersByTimeAsync(ms);
+        await new Promise((resolve) => setImmediate(resolve));
+      };
       app.stdin.write("\u0003");
       await wait(799);
       expect(app.lastFrame()).toContain("Press Ctrl-C again to exit");
@@ -990,3 +998,39 @@ describe("App's queue", () => {
     expect(app.lastFrame()).toContain("› three");
   });
 });
+
+describe("App's space on screen", () => {
+  const lines = (n: number) => [...Array(n).keys()].map((i) => `l${i}`).join("\r");
+
+  it("keeps the live part a row shorter than the terminal, showing a tall paste around the cursor", async () => {
+    const { app } = await mount([], { rows: 10 });
+    await press(app, `\u001b[200~${lines(20)}\u001b[201~`);
+    const frame = app.lastFrame()!;
+    expect(frame.split("\n")).toHaveLength(9);
+    expect(frame).toContain("› ↑ 14 rows above\n  l14\n");
+    expect(frame).toContain("  l19\n? for shortcuts\n");
+    await press(app, ...Array<string>(6).fill("\u001b[A")); // up to l13, past the window's top
+    expect(app.lastFrame()!.split("\n")).toHaveLength(9);
+    expect(app.lastFrame()).toContain("› ↑ 13 rows above\n  l13\n");
+    expect(app.lastFrame()).toContain("  ↓ 2 rows below\n");
+  });
+
+  it("gives the queue the rows the prompt leaves, the last saying how many more, or the hint line the count", async () => {
+    const { app } = await mount([], { lead: hanging(), rows: 8 });
+    await type(app, "one");
+    await until(app, "working");
+    for (const q of ["q1", "q2", "q3", "q4", "q5"]) await press(app, q, "\r");
+    expect(app.lastFrame()).toMatch(/working[^\n]*\nq1\nq2\n\+3 more\n›\n↑ to edit queued messages\n[^\n]*$/);
+    await press(app, "a", "\n", "b", "\n", "c", "\n", "d"); // four rows: none left for the queue
+    expect(app.lastFrame()).toMatch(/working[^\n]*\n› a\n  b\n  c\n  d\n5 queued\n[^\n]*$/);
+  });
+
+  it("drops the hint line when the terminal is too short for it and the cursor's row", async () => {
+    const { app } = await mount([], { rows: 3 });
+    expect(app.lastFrame()).toMatch(/^›\n[^\n]*$/);
+    Object.assign(app.stdout, { rows: 4 });
+    app.stdout.emit("resize");
+    await tick();
+    expect(app.lastFrame()).toMatch(/^›\n\? for shortcuts\n[^\n]*$/);
+  });
+});
```

**Change `tests/tui/layout.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/layout.test.ts b/tests/tui/layout.test.ts
index 2bd1795..d173c87 100644
--- a/tests/tui/layout.test.ts
+++ b/tests/tui/layout.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { layout, vertical } from "../../src/tui/layout.js";
+import { layout, scroll, vertical } from "../../src/tui/layout.js";
 
 describe("layout", () => {
   it("wraps the prompt at the width, by columns", () => {
@@ -49,3 +49,22 @@ describe("vertical", () => {
     expect(vertical("ab\ncd", 10, 4, 1, null)).toBeNull();
   });
 });
+
+describe("scroll", () => {
+  it("shows every row when they fit", () => {
+    expect(scroll(3, 5, 2, 0)).toEqual({ top: 0, above: 0, below: 0 });
+  });
+
+  it("keeps the cursor's row in view, the first and last rows shown counting the rows cut off", () => {
+    // Ten rows in four, the cursor on the last: rows 6 to 9 are shown, row 6 saying that 7 are above.
+    expect(scroll(10, 4, 9, 0)).toEqual({ top: 6, above: 7, below: 0 });
+    expect(scroll(10, 4, 7, 6)).toEqual({ top: 6, above: 7, below: 0 }); // still in view: the window stays
+    expect(scroll(10, 4, 6, 6)).toEqual({ top: 5, above: 6, below: 2 }); // one row up, and a count below
+    expect(scroll(10, 4, 1, 5)).toEqual({ top: 0, above: 0, below: 7 });
+  });
+
+  it("has no room for the counts in fewer than three rows", () => {
+    expect(scroll(10, 2, 5, 0)).toEqual({ top: 4, above: 0, below: 0 });
+    expect(scroll(10, 1, 5, 4)).toEqual({ top: 5, above: 0, below: 0 });
+  });
+});
```

**Change `tests/tui/prompt.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/prompt.test.tsx b/tests/tui/prompt.test.tsx
index 50498ec..a97191c 100644
--- a/tests/tui/prompt.test.tsx
+++ b/tests/tui/prompt.test.tsx
@@ -1,5 +1,6 @@
 import { EventEmitter } from "node:events";
 import { render, Text } from "ink";
+import { render as renderFrames } from "ink-testing-library";
 import { afterEach, describe, expect, it } from "vitest";
 import { load, empty } from "../../src/tui/editor.js";
 import { Prompt } from "../../src/tui/Prompt.js";
@@ -37,7 +38,7 @@ afterEach(() => {
 describe("Prompt", () => {
   it("puts the terminal's cursor where typing goes, after the two columns each row starts with", async () => {
     const terminal = new Terminal();
-    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} offset={0} />;
+    const at = (cursor: number) => <Prompt editor={{ ...load(empty, "abcd\nef"), cursor }} columns={terminal.columns} offset={0} space={terminal.rows} />;
     const app = render(at(2), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
     unmounts.push(app.unmount);
     await tick();
@@ -55,7 +56,7 @@ describe("Prompt", () => {
       <>
         <Text>working</Text>
         <Text>queued</Text>
-        <Prompt editor={{ ...load(empty, "abcd\nef"), cursor: 2 }} columns={terminal.columns} offset={2} />
+        <Prompt editor={{ ...load(empty, "abcd\nef"), cursor: 2 }} columns={terminal.columns} offset={2} space={terminal.rows} />
       </>
     );
     const app = render(tree, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
@@ -63,4 +64,38 @@ describe("Prompt", () => {
     await tick();
     expect(terminal.out).toContain("\u001b[2A\u001b[5G\u001b[?25h"); // up from below the four rows to the third
   });
+
+  it("shows a prompt taller than its space as a window that follows the cursor, counting the rows cut off", () => {
+    const text = [...Array(10).keys()].map((i) => `l${i}`).join("\n");
+    const at = (cursor: number) => <Prompt editor={{ ...load(empty, text), cursor }} columns={20} offset={0} space={4} />;
+    const app = renderFrames(at(text.length));
+    unmounts.push(app.unmount);
+    expect(app.lastFrame()).toBe("› ↑ 7 rows above\n  l7\n  l8\n  l9");
+    app.rerender(at(text.indexOf("l6")));
+    expect(app.lastFrame()).toBe("› ↑ 6 rows above\n  l6\n  l7\n  ↓ 2 rows below");
+  });
+
+  it("places the cursor in the window", async () => {
+    const terminal = new Terminal();
+    const text = [...Array(10).keys()].map((i) => `l${i}`).join("\n");
+    const app = render(<Prompt editor={load(empty, text)} columns={terminal.columns} offset={0} space={4} />, { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
+    unmounts.push(app.unmount);
+    await tick();
+    expect(terminal.out).toContain("\u001b[1A\u001b[5G\u001b[?25h"); // the window's last row, after "  l9"
+  });
+
+  it("keeps the cursor on the same character when the terminal is resized", async () => {
+    const terminal = new Terminal();
+    const at = () => <Prompt editor={{ ...load(empty, "a".repeat(30)), cursor: 25 }} columns={terminal.columns} offset={0} space={terminal.rows} />;
+    const app = render(at(), { stdout: terminal as never, stdin: new Keyboard() as never, debug: false, patchConsole: false, exitOnCtrlC: false, interactive: true });
+    unmounts.push(app.unmount);
+    await tick();
+    expect(terminal.out).toContain("\u001b[1A\u001b[11G\u001b[?25h"); // 17 columns a row: the second row, column 8
+    terminal.out = "";
+    terminal.columns = 12;
+    terminal.emit("resize");
+    app.rerender(at());
+    await tick();
+    expect(terminal.out).toContain("\u001b[2A\u001b[10G\u001b[?25h"); // 9 a row: the third of four rows, column 7
+  });
 });
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/layout.test.ts tests/tui/prompt.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 7 failed | 82 passed (89). A tall prompt still pushes the live part past the terminal's height.

**Step 3: Write the code**

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index d88cf80..e99f253 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -11,7 +11,7 @@ import { describe, type Line, screen } from "./describe.js";
 import { apply, type Editor, empty, load, move } from "./editor.js";
 import { History, matches } from "./history.js";
 import { type Command, commands } from "./keys.js";
-import { vertical } from "./layout.js";
+import { layout, vertical } from "./layout.js";
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
@@ -56,7 +56,7 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
   const step = useRef<{ at: number; draft: string } | null>(null); // where Up has gone in the history, and what was typed before
   // Ctrl+R: what is searched for, how many older matches Ctrl+R has passed, and the prompt to give back.
   const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
-  const { columns } = useWindowSize();
+  const { columns, rows: height } = useWindowSize();
   const [busy, setBusy] = useState(false);
   const working = useRef(false); // busy, for keys read before the screen is drawn again
   const queue = useRef<string[]>([]); // what Enter added during a turn, in order
@@ -371,20 +371,37 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     }
   };
 
-  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies.
+  // The hint line, under the prompt (release 3 design, "On screen"): whichever applies. `left` is the
+  // rows left for the queue.
   const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
   const searching = search.current && `search: ${visible(search.current.query)}${shown() === search.current.before ? " (no match)" : ""}`;
-  const hint = searching
-    ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
-    : exitKey
-      ? `Press ${exitKey} again to exit`
-      : picker || question
-        ? null
-        : queue.current.length
-          ? "↑ to edit queued messages"
-          : busy
-            ? null
-            : "? for shortcuts";
+  const hintFor = (left: number) =>
+    searching
+      ? `${searching} · Ctrl+R older · Enter send · Tab edit · Ctrl-C cancel`
+      : exitKey
+        ? `Press ${exitKey} again to exit`
+        : picker || question
+          ? null
+          : queue.current.length
+            ? left > 0
+              ? "↑ to edit queued messages"
+              : `${queue.current.length} queued`
+            : busy
+              ? null
+              : "? for shortcuts";
+
+  // The prompt's space (release 3 design): the live part stays a row shorter than the terminal, since
+  // at full height Ink draws the whole scrollback again each time. First the status line and the
+  // working line, and the hint line when there is room for it and the cursor's row; then the prompt;
+  // then the queue, the last row saying how many more there are when they do not all fit.
+  const room = height - 1 - 1 - (busy ? 1 : 0);
+  const hinted = hintFor(1) !== null && room >= 2;
+  const space = Math.max(1, room - (hinted ? 1 : 0));
+  const prompt = search.current ? shown() : editor.current;
+  const left = space - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, space);
+  const q = queue.current.map((e) => visible(e));
+  const queued = q.length <= left ? q : left > 0 ? [...q.slice(0, left - 1), `+${q.length - left + 1} more`] : [];
+  const hint = hinted ? hintFor(left) : null;
 
   return (
     <>
@@ -401,16 +418,20 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
         <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
       ) : (
         <>
-          {busy && <Text>… working (Ctrl-C to stop)</Text>}
-          {queue.current.map((q, i) => (
+          {busy && <Text wrap="truncate-end">… working (Ctrl-C to stop)</Text>}
+          {queued.map((row, i) => (
             <Text key={i} color="gray" wrap="truncate-end">
-              {visible(q)}
+              {row}
             </Text>
           ))}
-          <Prompt editor={search.current ? shown() : editor.current} columns={columns} offset={(busy ? 1 : 0) + queue.current.length} />
+          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + queued.length} space={space} />
         </>
       )}
-      {hint && <Text dimColor>{hint}</Text>}
+      {hint && (
+        <Text dimColor wrap="truncate-end">
+          {hint}
+        </Text>
+      )}
       <StatusLine
         segments={segments}
         info={{
```

**Change `src/tui/Prompt.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/Prompt.tsx b/src/tui/Prompt.tsx
index d310285..c63fb95 100644
--- a/src/tui/Prompt.tsx
+++ b/src/tui/Prompt.tsx
@@ -1,6 +1,7 @@
 import { Text, useCursor } from "ink";
+import { useRef } from "react";
 import type { Editor } from "./editor.js";
-import { layout } from "./layout.js";
+import { layout, scroll } from "./layout.js";
 
 // The columns the prompt's text may use: two go before it ("› " on the first row), and one after a
 // full row is kept for the cursor.
@@ -9,17 +10,27 @@ export const promptWidth = (columns: number) => Math.max(1, columns - 3);
 // The prompt, wrapped to the screen (release 3 design, "Multi-line"), with the terminal's own cursor
 // where typing goes, so input methods work. Shown only while the prompt has the keys: when it is not
 // drawn, Ink hides the cursor. `offset` is the rows drawn above it, since Ink places the cursor from
-// the top of what it draws.
-export function Prompt({ editor, columns, offset }: { editor: Editor; columns: number; offset: number }) {
+// the top of what it draws. Taller than `space` rows, it shows the rows around the cursor.
+export function Prompt({ editor, columns, offset, space }: { editor: Editor; columns: number; offset: number; space: number }) {
   const { rows, places } = layout(editor.text, promptWidth(columns));
   const at = places.get(editor.cursor)!;
-  useCursor().setCursorPosition({ x: 2 + at.col, y: offset + at.row });
+  const shown = Math.min(rows.length, Math.max(1, space));
+  const top = useRef(0); // the window's first row, kept from one drawing to the next
+  const w = scroll(rows.length, shown, at.row, top.current);
+  top.current = w.top;
+  useCursor().setCursorPosition({ x: 2 + at.col, y: offset + at.row - w.top });
   return (
     <>
-      {rows.map((row, i) => (
+      {rows.slice(w.top, w.top + shown).map((row, i) => (
         <Text key={i}>
           {i ? "  " : "› "}
-          {row}
+          {i === 0 && w.above ? (
+            <Text dimColor>↑ {w.above} rows above</Text>
+          ) : i === shown - 1 && w.below ? (
+            <Text dimColor>↓ {w.below} rows below</Text>
+          ) : (
+            row
+          )}
         </Text>
       ))}
     </>
```

**Change `src/tui/layout.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/layout.ts b/src/tui/layout.ts
index d89008e..d408738 100644
--- a/src/tui/layout.ts
+++ b/src/tui/layout.ts
@@ -57,3 +57,20 @@ export function vertical(text: string, width: number, cursor: number, dir: -1 |
   }
   return best === null ? null : { cursor: best, goal: aim };
 }
+
+// Which rows of a prompt taller than its space are shown (release 3 design, "The prompt's space"):
+// `space` rows from `top`, keeping the cursor's row in view, moved from the window shown before (its
+// `top`) only as far as the cursor needs. A row cut off above or below gives its place to a count of
+// the rows hidden there, itself included, when there are three rows or more: the cursor's row always
+// stays between the counts.
+export function scroll(total: number, space: number, cursor: number, top: number): { top: number; above: number; below: number } {
+  if (total <= space) return { top: 0, above: 0, below: 0 };
+  const marks = space >= 3;
+  const clamp = (t: number) => Math.min(Math.max(t, 0), total - space);
+  let t = clamp(top);
+  const first = t + (marks && t > 0 ? 1 : 0); // the first and last rows of text shown
+  const last = t + space - 1 - (marks && t + space < total ? 1 : 0);
+  if (cursor < first) t = clamp(!marks ? cursor : cursor > 1 ? cursor - 1 : 0);
+  else if (cursor > last) t = clamp(cursor - space + (marks && cursor < total - 1 ? 2 : 1));
+  return { top: t, above: marks && t > 0 ? t + 1 : 0, below: marks && t + space < total ? total - (t + space - 1) : 0 };
+}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 32 passed | 2 skipped (34); Tests 509 passed | 7 skipped (516).

**Step 5: Commit**

```bash
git add src/tui/App.tsx src/tui/Prompt.tsx src/tui/layout.ts tests/tui/app.test.tsx tests/tui/layout.test.ts tests/tui/prompt.test.tsx
git commit -m "feat: the prompt's space: a row short of the terminal, a window that follows the cursor, the queue in what is left"
```

### Task 11: The `/` and `@` menus

The design's "Menus and modes":
- **`src/tui/menus.ts`** works out a menu from the prompt's text. `/` and a word at the start of the
  prompt, with the cursor at the end, lists the commands, each with what it does. `@` at the start or
  after a space lists the folder typed so far (`@` alone is the project folder), narrowing as you
  type. A folder that cannot be listed says why; what the file tools refuse, such as Tachikoma's
  data folder, is never listed.
- **`src/tui/Menu.tsx`** draws it under the prompt, in the rows left, scrolling with the chosen
  entry.
- **App:** Up and Down choose; Tab fills the entry in; Enter runs a command, or fills a path; Esc
  closes it until the text changes. While a menu is open the prompt is cut to the cursor's row, and
  the hint line says which keys do what. `editor.ts` gains `replace()`, one undo step.

Only the path is sent; the model reads the file with `read_file`, through the same guards. Choice 8
covers the rest.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/tui/App.tsx`
- Create: `src/tui/Menu.tsx`
- Modify: `src/tui/editor.ts`
- Create: `src/tui/menus.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/editor.test.ts`
- Create: `tests/tui/menus.test.ts`

**Step 1: Write the failing tests**

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index 9c8ce3c..fd1b148 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -1,5 +1,5 @@
 import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
-import { mkdtemp } from "node:fs/promises";
+import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
 import { tmpdir } from "node:os";
 import path from "node:path";
 import { render } from "ink-testing-library";
@@ -79,6 +79,7 @@ async function mount(
       stats={stats}
       mode="ask"
       project="proj"
+      root={ctx.root}
       gitBranch={() => opts.branches?.shift() ?? null}
       historyFile={historyFile}
       errorFile={opts.errorFile ?? path.join(ctx.root, "errors.jsonl")}
@@ -246,9 +247,12 @@ describe("App", () => {
     await until(app, "login done 1");
     await type(app, "/logout chatgpt");
     await until(app, "logout done 2");
-    await type(app, "/login"); // shown how to use it, not called an unknown command
+    // With the `/` menu closed, the command as typed: shown how to use it, not called an unknown command.
+    await press(app, "/login", "\u001b", "\r");
     await until(app, "login done 3");
-    expect(calls).toEqual(["/login chatgpt --new", "/logout chatgpt", "/login"]);
+    await type(app, "/login"); // with the menu open, Enter runs what it has chosen
+    await until(app, "login done 4");
+    expect(calls).toEqual(["/login chatgpt --new", "/logout chatgpt", "/login", "/login chatgpt"]);
     expect(lead.seen).toEqual([]);
   });
 
@@ -1034,3 +1038,78 @@ describe("App's space on screen", () => {
     expect(app.lastFrame()).toMatch(/^›\n\? for shortcuts\n[^\n]*$/);
   });
 });
+
+describe("App's menus", () => {
+  it("lists the commands for / at the start of an empty prompt, narrowing as the command is typed", async () => {
+    const { app } = await mount([]);
+    await press(app, "/");
+    expect(app.lastFrame()).toContain("› /\n  /lead <provider:model>  Switch the lead model\n  /model  Pick the lead model from a list\n");
+    expect(app.lastFrame()).toContain("↑↓ choose · Tab fill · Enter run · Esc close");
+    await press(app, "e");
+    expect(app.lastFrame()).toContain("› /e\n  /errors  Summarise the error log\n  /exit  Quit\n");
+    expect(app.lastFrame()).not.toContain("/model");
+  });
+
+  it("runs the chosen command on Enter, Down choosing the next", async () => {
+    const { app } = await mount([]);
+    await press(app, "/", "e", "\u001b[B", "\r");
+    await expectExited(app);
+  });
+
+  it("puts the command in the prompt on Tab, to add to it", async () => {
+    const made: string[] = [];
+    const { app } = await mount([], { made });
+    await press(app, "/", "l", "\t");
+    expect(app.lastFrame()).toContain("› /lead\n"); // the space after it is there, though not drawn
+    expect(app.lastFrame()).not.toContain("Switch the lead model");
+    await press(app, "fake:b", "\r");
+    await until(app, "lead is now fake:b");
+    expect(made).toEqual(["fake:b"]);
+  });
+
+  it("closes on Esc until the text changes, and a message starting with a slash is sent as typed", async () => {
+    const { app, session } = await mount([reply("ok")]);
+    await press(app, "/", "\u001b");
+    expect(app.lastFrame()).not.toContain("/model");
+    expect(app.lastFrame()).toContain("› /\n");
+    await press(app, "m");
+    expect(app.lastFrame()).toContain("/model  Pick the lead model from a list");
+    await press(app, "\u007f"); // back at the text Esc closed it at, after a change: open
+    expect(app.lastFrame()).toContain("/model  Pick the lead model from a list");
+    await press(app, "\u007f", "/tmp is full", "\r");
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: "/tmp is full" });
+  });
+
+  it("lists the project folder for @, goes into a folder on Tab, and completes a file's path on Enter; only the path is sent", async () => {
+    const { app, session, ctx } = await mount([reply("ok")]);
+    await mkdir(path.join(ctx.root, "src"));
+    await writeFile(path.join(ctx.root, "src", "x.ts"), "secret");
+    await writeFile(path.join(ctx.root, "a.txt"), "");
+    await press(app, "read @");
+    expect(app.lastFrame()).toContain("› read @\n  src/\n  a.txt\n↑↓ choose · Tab or Enter fill · Esc close");
+    await press(app, "s", "\t");
+    expect(app.lastFrame()).toContain("› read @src/\n  src/x.ts\n");
+    await press(app, "\r");
+    expect(app.lastFrame()).toContain("› read @src/x.ts\n");
+    await press(app, "\r");
+    await until(app, "ok");
+    expect(sent(session)).toEqual({ type: "text", text: "read @src/x.ts" });
+  });
+
+  it("says in the menu why a folder cannot be listed", async () => {
+    const { app } = await mount([]);
+    await press(app, "@nope/");
+    expect(app.lastFrame()).toMatch(/› @nope\/\n {2}Cannot list nope\/: ENOENT/);
+  });
+
+  it("cuts the prompt to the cursor's row while a menu is open, and fits the menu in the rows left", async () => {
+    const { app, ctx } = await mount([], { rows: 8 });
+    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6"]) await writeFile(path.join(ctx.root, name), "");
+    await press(app, "one", "\n", "two", "\n", "@a");
+    // Seven rows: the prompt's cursor row, four for the menu, the hint line and the status line.
+    expect(app.lastFrame()).toMatch(/^› @a\n {2}a1\n {2}a2\n {2}a3\n {2}↓ 3 more\n↑↓ choose[^\n]*\n[^\n]*$/);
+    await press(app, "\u001b[B", "\u001b[B", "\u001b[B");
+    expect(app.lastFrame()).toMatch(/^› @a\n {2}↑ 2 more\n {2}a3\n {2}a4\n {2}↓ 2 more\n/);
+  });
+});
```

**Change `tests/tui/editor.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/editor.test.ts b/tests/tui/editor.test.ts
index 06df327..d4e96c4 100644
--- a/tests/tui/editor.test.ts
+++ b/tests/tui/editor.test.ts
@@ -1,5 +1,5 @@
 import { describe, expect, it } from "vitest";
-import { type Action, apply, type Editor, empty, load } from "../../src/tui/editor.js";
+import { type Action, apply, type Editor, empty, load, replace } from "../../src/tui/editor.js";
 
 // The text with the cursor shown as "|".
 const show = (e: Editor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;
@@ -97,3 +97,11 @@ describe("editor", () => {
     expect(show(run(e, "yank"))).toBe("two\nlinesyz|");
   });
 });
+
+describe("replace", () => {
+  it("puts text in place of what is before the cursor from a place, as one step to undo", () => {
+    const e = replace(run(at("|"), typed("read @s")), 5, "@src/");
+    expect(show(e)).toBe("read @src/|");
+    expect(show(run(e, "undo"))).toBe("read @s|");
+  });
+});
```

**Create `tests/tui/menus.test.ts`:**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandMenu, listFolder, pathMenu } from "../../src/tui/menus.js";
import { tempContext } from "../helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const labels = (m: ReturnType<typeof commandMenu>) => m?.entries.map((e) => e.label);

describe("commandMenu", () => {
  it("lists every command for a slash at the start of the prompt, each saying what it does", () => {
    const m = commandMenu("/", 1);
    expect(labels(m)).toEqual(["/lead <provider:model>", "/model", "/login chatgpt", "/logout chatgpt", "/errors", "/exit"]);
    expect(m!.entries[0]).toMatchObject({ note: "Switch the lead model", fill: "/lead ", run: "/lead" });
  });

  it("narrows as the command is typed, in any case", () => {
    expect(labels(commandMenu("/lo", 3))).toEqual(["/login chatgpt", "/logout chatgpt"]);
    expect(labels(commandMenu("/LOGO", 5))).toEqual(["/logout chatgpt"]);
  });

  it("is closed for a message, after a space, away from the start, or with the cursor before the end", () => {
    expect(commandMenu("/tmp", 4)).toBeNull();
    expect(commandMenu("/lead x", 7)).toBeNull();
    expect(commandMenu("x /l", 4)).toBeNull();
    expect(commandMenu("/le", 1)).toBeNull();
    expect(commandMenu("", 0)).toBeNull();
  });
});

describe("pathMenu", () => {
  const list = (folder: string) =>
    folder === "src/" ? { entries: [{ name: "x.ts", folder: false }] } : folder === "" ? { entries: [{ name: "src", folder: true }, { name: "a.txt", folder: false }, { name: "Sub", folder: true }] } : { error: `ENOENT ${folder}` };

  it("lists the project folder for @ at the start or after a space, folders ending in /", () => {
    for (const text of ["@", "read @"]) {
      const m = pathMenu(text, text.length, list);
      expect(labels(m)).toEqual(["src/", "a.txt", "Sub/"]);
      expect(m!.from).toBe(text.length - 1);
    }
    expect(pathMenu("a@", 2, list)).toBeNull();
  });

  it("narrows by the name being typed, in any case, and lists the folder typed so far", () => {
    expect(labels(pathMenu("@s", 2, list))).toEqual(["src/", "Sub/"]);
    expect(pathMenu("@s", 2, list)!.entries[1]!.fill).toBe("@Sub/");
    const m = pathMenu("@src/", 5, list);
    expect(labels(m)).toEqual(["src/x.ts"]);
    expect(m!.entries[0]!.fill).toBe("@src/x.ts ");
    expect(pathMenu("@zz", 3, list)).toBeNull();
  });

  it("says why a folder cannot be listed", () => {
    expect(pathMenu("@nope/", 6, list)!.entries).toEqual([{ label: "Cannot list nope/: ENOENT nope/", fill: "", error: true }]);
  });
});

describe("listFolder", () => {
  it("lists folders first, then files, each by name", async () => {
    const { root } = await tempContext();
    await mkdir(path.join(root, "b"));
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "c.txt"), "");
    await writeFile(path.join(root, "0.txt"), "");
    expect(listFolder(root, "")).toEqual({
      entries: [
        { name: "a", folder: true },
        { name: "b", folder: true },
        { name: "0.txt", folder: false },
        { name: "c.txt", folder: false },
      ],
    });
  });

  it("never lists Tachikoma's data folder or what is in it, as the file tools never touch it", async () => {
    const { root } = await tempContext();
    const data = path.join(root, "data");
    await mkdir(data);
    await writeFile(path.join(data, "chatgpt.json"), "{}");
    await writeFile(path.join(root, "kept.txt"), "");
    vi.stubEnv("TACHI_DATA_DIR", data);
    expect(listFolder(root, "")).toEqual({ entries: [{ name: "kept.txt", folder: false }] });
    expect(listFolder(root, "data/")).toEqual({ error: expect.stringContaining("Tachikoma's data folder") });
  });

  it("gives the reason a folder cannot be listed", async () => {
    const { root } = await tempContext();
    expect(listFolder(root, "nope/")).toEqual({ error: expect.stringContaining("ENOENT") });
  });
});
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/tui/app.test.tsx tests/tui/editor.test.ts tests/tui/menus.test.ts`

Expected: FAIL. In the scratch build: Test Files 3 failed (3); Tests 9 failed | 87 passed (96). `src/tui/menus.ts` and `src/tui/Menu.tsx` do not exist yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 7b28e2c..010dba5 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -189,6 +189,7 @@ if (parsed.print !== undefined) {
       stats={stats}
       mode={mode}
       project={path.basename(root) || root}
+      root={root}
       gitBranch={() => gitBranch(root)}
       historyFile={historyFile(root)}
       errorFile={errorFile}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index e99f253..d7944e2 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -8,10 +8,12 @@ import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
 import { describe, type Line, screen } from "./describe.js";
-import { apply, type Editor, empty, load, move } from "./editor.js";
+import { apply, type Editor, empty, load, move, replace } from "./editor.js";
 import { History, matches } from "./history.js";
 import { type Command, commands } from "./keys.js";
 import { layout, vertical } from "./layout.js";
+import { Menu } from "./Menu.js";
+import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu } from "./menus.js";
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
@@ -24,6 +26,7 @@ export interface AppProps {
   stats: Stats;
   mode: Mode;
   project: string; // the project folder's name, for the status line
+  root: string; // the project folder, where `@` paths start
   gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
   historyFile: string; // this project's past prompts
   errorFile: string;
@@ -45,7 +48,7 @@ const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (
 const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
 const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
 
-export function App({ session, bus, stats, mode, project, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, bus, stats, mode, project, root, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
@@ -56,6 +59,11 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
   const step = useRef<{ at: number; draft: string } | null>(null); // where Up has gone in the history, and what was typed before
   // Ctrl+R: what is searched for, how many older matches Ctrl+R has passed, and the prompt to give back.
   const search = useRef<{ query: string; skip: number; before: Editor } | null>(null);
+  // The menus: the entry chosen, for the text it was chosen at; the text Esc closed one at, which
+  // keeps it closed until the text changes; and the folder `@` listed last.
+  const chosen = useRef({ text: "", at: 0 });
+  const closed = useRef<string | null>(null);
+  const listed = useRef<{ folder: string; listing: Listing } | null>(null);
   const { columns, rows: height } = useWindowSize();
   const [busy, setBusy] = useState(false);
   const working = useRef(false); // busy, for keys read before the screen is drawn again
@@ -233,6 +241,13 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
       return rerender((n) => n + 1);
     }
     const e = editor.current;
+    const menu = menuFor(e);
+    if (menu && ((key.tab && !key.shift) || key.escape)) {
+      if (key.escape) closed.current = e.text;
+      else fill(menu, e);
+      forget();
+      return rerender((n) => n + 1);
+    }
     const name = key.escape ? "Esc" : key.ctrl && ch === "c" ? "Ctrl-C" : key.ctrl && ch === "d" && !e.text ? "Ctrl-D" : null;
     // During a turn the prompt still edits; Esc stops the turn and the queue goes on, Ctrl-C stops it
     // and the queue comes back. Ctrl-D does not exit while a turn is running.
@@ -278,6 +293,12 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
 
   const run = (c: Command) => {
     const e = editor.current;
+    const menu = menuFor(e);
+    if (menu && (c === "up" || c === "down")) {
+      chosen.current = { text: e.text, at: Math.max(0, Math.min(menu.entries.length - 1, chosenIn(e, menu) + (c === "up" ? -1 : 1))) };
+      return;
+    }
+    if (menu && c === "submit") return menu.kind === "command" ? send(load(e, menu.entries[chosenIn(e, menu)]!.run!)) : fill(menu, e);
     if (c === "up" && !e.text && queue.current.length) return restore();
     if (c === "up" || c === "down") {
       const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
@@ -340,6 +361,24 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     }
   };
 
+  // The `/` or `@` menu for the prompt as it is, unless Esc closed it at this text. A folder is listed
+  // again when the menu opens again, so it shows what is there then.
+  const menuFor = (e: Editor): MenuData | null => {
+    if (closed.current !== e.text) closed.current = null;
+    if (search.current || closed.current !== null) return null;
+    return commandMenu(e.text, e.cursor) ?? pathMenu(e.text, e.cursor, list);
+  };
+  const list = (folder: string) => {
+    if (listed.current?.folder !== folder) listed.current = { folder, listing: listFolder(root, folder) };
+    return listed.current.listing;
+  };
+  const chosenIn = (e: Editor, m: MenuData) => Math.min(chosen.current.text === e.text ? chosen.current.at : 0, m.entries.length - 1);
+  // Tab, and Enter on a path: the chosen entry in place of what it completes.
+  const fill = (m: MenuData, e: Editor) => {
+    const entry = m.entries[chosenIn(e, m)]!;
+    if (!entry.error) editor.current = replace(e, m.from, entry.fill);
+  };
+
   // What the search shows in the prompt: the match, with the cursor at its end, or, with no match,
   // the prompt as it was.
   const shown = (): Editor => {
@@ -371,6 +410,10 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
     }
   };
 
+  const prompt = search.current ? shown() : editor.current;
+  const menu = picker || question ? null : menuFor(prompt);
+  if (menu?.kind !== "path") listed.current = null;
+
   // The hint line, under the prompt (release 3 design, "On screen"): whichever applies. `left` is the
   // rows left for the queue.
   const exitKey = first.current?.name === "Esc" ? undefined : first.current?.name;
@@ -382,7 +425,9 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
         ? `Press ${exitKey} again to exit`
         : picker || question
           ? null
-          : queue.current.length
+          : menu
+            ? `↑↓ choose · ${menu.kind === "command" ? "Tab fill · Enter run" : "Tab or Enter fill"} · Esc close`
+            : queue.current.length
             ? left > 0
               ? "↑ to edit queued messages"
               : `${queue.current.length} queued`
@@ -392,13 +437,15 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
 
   // The prompt's space (release 3 design): the live part stays a row shorter than the terminal, since
   // at full height Ink draws the whole scrollback again each time. First the status line and the
-  // working line, and the hint line when there is room for it and the cursor's row; then the prompt;
-  // then the queue, the last row saying how many more there are when they do not all fit.
+  // working line, and the hint line when there is room for it and the cursor's row; then an open menu,
+  // with the prompt cut to the cursor's row; then the prompt; then the queue, the last row saying how
+  // many more there are when they do not all fit.
   const room = height - 1 - 1 - (busy ? 1 : 0);
   const hinted = hintFor(1) !== null && room >= 2;
   const space = Math.max(1, room - (hinted ? 1 : 0));
-  const prompt = search.current ? shown() : editor.current;
-  const left = space - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, space);
+  const menuRows = menu ? Math.min(menu.entries.length, Math.max(1, space - 1)) : 0;
+  const promptSpace = menu ? 1 : space;
+  const left = space - menuRows - Math.min(layout(prompt.text, promptWidth(columns)).rows.length, promptSpace);
   const q = queue.current.map((e) => visible(e));
   const queued = q.length <= left ? q : left > 0 ? [...q.slice(0, left - 1), `+${q.length - left + 1} more`] : [];
   const hint = hinted ? hintFor(left) : null;
@@ -424,7 +471,8 @@ export function App({ session, bus, stats, mode, project, gitBranch, historyFile
               {row}
             </Text>
           ))}
-          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + queued.length} space={space} />
+          <Prompt editor={prompt} columns={columns} offset={(busy ? 1 : 0) + queued.length} space={promptSpace} />
+          {menu && <Menu entries={menu.entries} chosen={chosenIn(prompt, menu)} rows={menuRows} />}
         </>
       )}
       {hint && (
```

**Create `src/tui/Menu.tsx`:**

```tsx
import { Text } from "ink";
import { useRef } from "react";
import { visible } from "../core/permissions.js";
import { scroll } from "./layout.js";
import type { Entry } from "./menus.js";

// An open `/` or `@` menu, under the prompt, in `rows` rows: past that it scrolls with the chosen
// entry, as the prompt does with the cursor, the first and last rows counting the entries cut off.
export function Menu({ entries, chosen, rows }: { entries: Entry[]; chosen: number; rows: number }) {
  const shown = Math.min(entries.length, Math.max(1, rows));
  const top = useRef(0);
  const w = scroll(entries.length, shown, chosen, top.current);
  top.current = w.top;
  return (
    <>
      {entries.slice(w.top, w.top + shown).map((e, i) =>
        i === 0 && w.above ? (
          <Text key={i} dimColor>
            {"  "}↑ {w.above} more
          </Text>
        ) : i === shown - 1 && w.below ? (
          <Text key={i} dimColor>
            {"  "}↓ {w.below} more
          </Text>
        ) : (
          <Text key={i} wrap="truncate-end" color={e.error ? "red" : undefined}>
            {"  "}
            <Text inverse={w.top + i === chosen && !e.error}>{visible(e.label)}</Text>
            {e.note && <Text dimColor>{`  ${e.note}`}</Text>}
          </Text>
        ),
      )}
    </>
  );
}
```

**Change `src/tui/editor.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/editor.ts b/src/tui/editor.ts
index c718c16..a88d33e 100644
--- a/src/tui/editor.ts
+++ b/src/tui/editor.ts
@@ -89,6 +89,9 @@ function change(e: Editor, from: number, to: number, insert: string, how: { typi
   };
 }
 
+// `insert` in place of the text from `from` to the cursor, as one step: a menu's choice.
+export const replace = (e: Editor, from: number, insert: string): Editor => change(e, from, e.cursor, insert);
+
 // The cursor somewhere else, which ends a run of typing. App moves it up and down by screen row.
 export const move = (e: Editor, cursor: number): Editor => ({ ...e, cursor, typing: false });
 
```

**Create `src/tui/menus.ts`:**

```ts
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { errorText } from "../core/types.js";
import { resolveIn } from "../tools/files.js";

// The `/` and `@` menus (release 3 design, "Menus and modes"), worked out from the prompt's text: what
// each entry shows, what Tab (and, for a path, Enter) puts in the prompt in place of the text from
// `from` to the cursor, and what Enter runs.

export interface Entry {
  label: string;
  note?: string; // what a command does
  fill: string;
  run?: string;
  error?: true; // a folder that could not be listed: shown, never filled
}

export interface Menu {
  kind: "command" | "path";
  from: number;
  entries: Entry[];
}

// The commands, as the README lists them, with what each does.
const COMMANDS: { label: string; run: string; note: string }[] = [
  { label: "/lead <provider:model>", run: "/lead", note: "Switch the lead model" },
  { label: "/model", run: "/model", note: "Pick the lead model from a list" },
  { label: "/login chatgpt", run: "/login chatgpt", note: "Sign in to ChatGPT" },
  { label: "/logout chatgpt", run: "/logout chatgpt", note: "Sign out of ChatGPT" },
  { label: "/errors", run: "/errors", note: "Summarise the error log" },
  { label: "/exit", run: "/exit", note: "Quit" },
];

// A slash at the start of the prompt and the word after it, with the cursor at the end: commands
// count only there, so "/tmp is full" is a message.
export function commandMenu(text: string, cursor: number): Menu | null {
  if (cursor !== text.length || !/^\/\S*$/.test(text)) return null;
  const typed = text.toLowerCase();
  const entries = COMMANDS.filter((c) => c.run.startsWith(typed)).map((c) => ({ label: c.label, note: c.note, fill: `${c.run.split(" ")[0]} `, run: c.run }));
  return entries.length ? { kind: "command", from: 0, entries } : null;
}

export type Listing = { entries: { name: string; folder: boolean }[] } | { error: string };

// `@` at the start or after a space, then a path, up to the cursor: the folder typed so far (the
// project folder for none) listed, narrowed by the name after it, in any case. A folder goes in with
// its "/", so the next Tab lists it; a file is completed with a space after it.
export function pathMenu(text: string, cursor: number, list: (folder: string) => Listing): Menu | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cursor));
  if (!m || /\S/.test(text[cursor] ?? "")) return null;
  const typed = m[1]!;
  const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\")) + 1;
  const folder = typed.slice(0, cut);
  const part = typed.slice(cut).toLowerCase();
  const from = cursor - typed.length - 1;
  const listing = list(folder);
  if ("error" in listing) return { kind: "path", from, entries: [{ label: `Cannot list ${folder || "the project folder"}: ${listing.error}`, fill: "", error: true }] };
  const entries = listing.entries
    .filter((e) => e.name.toLowerCase().startsWith(part))
    .map((e) => ({ label: `${folder}${e.name}${e.folder ? "/" : ""}`, fill: `@${folder}${e.name}${e.folder ? "/" : " "}` }));
  return entries.length ? { kind: "path", from, entries } : null;
}

// A folder of the project, or one a path leads to: folders first, then files, each by name. What the
// file tools refuse (Tachikoma's data folder, a program's environment) is left out, by the same check.
export function listFolder(root: string, folder: string): Listing {
  try {
    const dir = resolveIn(root, folder || ".").abs;
    const entries = readdirSync(dir).flatMap((name) => {
      const abs = path.join(dir, name);
      try {
        resolveIn(root, abs);
      } catch {
        return [];
      }
      return [{ name, folder: statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true }];
    });
    return { entries: entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)) };
  } catch (err) {
    return { error: errorText(err) };
  }
}
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 33 passed | 2 skipped (35); Tests 526 passed | 7 skipped (533).

**Step 5: Commit**

```bash
git add src/cli.tsx src/tui/App.tsx src/tui/Menu.tsx src/tui/editor.ts src/tui/menus.ts tests/tui/app.test.tsx tests/tui/editor.test.ts tests/tui/menus.test.ts
git commit -m "feat: the / and @ menus: commands and project paths under the prompt, Tab fills, Enter runs or fills, Esc closes"
```

### Task 12: `?`, Shift+Tab, Alt+P and Ctrl+O

The rest of the design's "Menus and modes":
- **`?` on an empty prompt** prints the key list, grey. A message starting with `?` needs a space
  typed first.
- **Shift+Tab** switches between `ask` and `project`; `never` joins the cycle only for a session
  started with `--mode never`, so no key press turns off the checks a session started with. The
  status line changes and a grey line says "mode is now project". It applies from the next action:
  `PermissionGate.mode` can now be changed, and is read at each check. Shift+Tab does nothing while
  a question is showing.
- **Alt+P** opens the model list, as `/model` does.
- **Ctrl+O** prints every tool call of the latest turn with its full input and result, grey, under
  "Last turn: N tool calls" (`lastTurn()` in `describe.ts`), cleaned of escape codes like everything
  in the scrollback. Before any turn it says there is none.

Choice 9 covers the rest.

**Files:**
- Modify: `src/cli.tsx`
- Modify: `src/core/permissions.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/describe.ts`
- Modify: `src/tui/keys.ts`
- Modify: `tests/core/permissions.test.ts`
- Modify: `tests/tui/app.test.tsx`
- Modify: `tests/tui/keys.test.ts`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/core/permissions.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/permissions.test.ts b/tests/core/permissions.test.ts
index 75c2b0c..85d6369 100644
--- a/tests/core/permissions.test.ts
+++ b/tests/core/permissions.test.ts
@@ -47,6 +47,15 @@ describe("PermissionGate", () => {
     await expect(gate.require(act("shell"))).rejects.toThrow("Not allowed in -p mode: shell");
   });
 
+  it("reads its mode at each check, so a change applies from the next action", async () => {
+    let asked = 0;
+    const gate = new PermissionGate("ask", async () => (asked++, true));
+    await gate.require(act("write"));
+    gate.mode = "project";
+    await gate.require(act("write"));
+    expect(asked).toBe(1);
+  });
+
   it("does not ask when no approval is needed", async () => {
     let asked = false;
     const gate = new PermissionGate("ask", async () => (asked = true));
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index fd1b148..d458f16 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -5,7 +5,7 @@ import path from "node:path";
 import { render } from "ink-testing-library";
 import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
 import { privateDir } from "../../src/auth/private.js";
-import { PermissionGate } from "../../src/core/permissions.js";
+import { type Mode, PermissionGate } from "../../src/core/permissions.js";
 import { Session } from "../../src/core/session.js";
 import { Stats } from "../../src/core/stats.js";
 import type { Provider } from "../../src/core/types.js";
@@ -61,13 +61,14 @@ async function mount(
     past?: string[]; // the project's prompts from earlier sessions
     newLead?: Provider; // what /lead and the picker make
     rows?: number; // the terminal's height
+    mode?: Mode; // the mode the session starts in
   } = {},
 ) {
   const bus = new Bus();
   const stats = new Stats(bus);
   const ctx = await tempContext();
   let ask: (s: string, d?: string) => Promise<boolean> = async () => false;
-  const gate = new PermissionGate("ask", (s, d) => ask(s, d));
+  const gate = new PermissionGate(opts.mode ?? "ask", (s, d) => ask(s, d));
   const lead = opts.lead ?? new FakeProvider("a", turns);
   const session = new Session({ lead, tools: TOOLS, system: "t", ctx: { ...ctx, gate }, bus });
   const historyFile = opts.historyFile ?? path.join(histories, `${nextHistory++}.jsonl`);
@@ -77,7 +78,10 @@ async function mount(
       session={session}
       bus={bus}
       stats={stats}
-      mode="ask"
+      mode={opts.mode ?? "ask"}
+      onMode={(m) => {
+        gate.mode = m;
+      }}
       project="proj"
       root={ctx.root}
       gitBranch={() => opts.branches?.shift() ?? null}
@@ -1113,3 +1117,81 @@ describe("App's menus", () => {
     expect(app.lastFrame()).toMatch(/^› @a\n {2}↑ 2 more\n {2}a3\n {2}a4\n {2}↓ 2 more\n/);
   });
 });
+
+describe("App's keys for the modes, the model list and the last turn", () => {
+  it("prints the key list, grey, on ? at an empty prompt; with a space first, ? is typed", async () => {
+    const { app } = await mount([]);
+    await press(app, "?");
+    expect(app.lastFrame()).toContain("Keys:\n");
+    expect(app.lastFrame()).toContain("Shift+Enter, \\ then Enter, or Ctrl+J  new line");
+    expect(app.lastFrame()).toContain("Ctrl+O  the last turn's tool calls in full");
+    // Keys that work in Windows Terminal, where Ctrl+Backspace is Backspace and Ctrl+_ cannot be typed.
+    expect(app.lastFrame()).toContain("Alt+Backspace  the word before");
+    expect(app.lastFrame()).toContain("Ctrl+Z  undo");
+    expect(app.lastFrame()).not.toContain("Ctrl+Backspace");
+    expect(app.lastFrame()).toContain("\n›\n"); // the prompt stays empty
+    await press(app, " ?");
+    expect(app.lastFrame()).toContain("›  ?\n");
+  });
+
+  it("switches between ask and project on Shift+Tab, saying so, and the check uses the new mode from the next action", async () => {
+    const { app, ctx } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
+    await press(app, "\u001b[Z");
+    expect(app.lastFrame()).toContain("mode is now project");
+    expect(app.lastFrame()).toContain("perm project");
+    await type(app, "go");
+    await until(app, "written"); // not asked: project mode allows writes inside the project
+    expect(existsSync(path.join(ctx.root, "a.txt"))).toBe(true);
+    await press(app, "\u001b[Z");
+    expect(app.lastFrame()).toContain("mode is now ask");
+    expect(app.lastFrame()).toContain("perm ask");
+  });
+
+  it("takes never into the cycle only when the session started in it", async () => {
+    const { app } = await mount([], { mode: "never" });
+    await press(app, "\u001b[Z", "\u001b[Z", "\u001b[Z");
+    expect(app.lastFrame()).toContain("mode is now ask\nmode is now project\nmode is now never\n");
+  });
+
+  it("does nothing on Shift+Tab while a question is showing", async () => {
+    const { app } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
+    await type(app, "go");
+    await until(app, "Allow");
+    await press(app, "\u001b[Z");
+    expect(app.lastFrame()).not.toContain("mode is now");
+    expect(app.lastFrame()).toContain("perm ask");
+    await press(app, "n");
+    await until(app, "written");
+  });
+
+  it("opens the model list on Alt+P, keeping what was typed", async () => {
+    const { app } = await mount([], { models: [{ provider: "fake", models: ["a", "b"] }] });
+    await press(app, "draft", "\u001bp");
+    await until(app, "fake:b");
+    await tick(); // the picker starts reading keys just after it first appears
+    await press(app, "\u001b");
+    await until(app, "› draft");
+  });
+
+  it("queues the model list on Alt+P during a turn, as /model typed then", async () => {
+    const { app } = await mount([], { lead: hanging(), models: [{ provider: "fake", models: ["a", "b"] }] });
+    await type(app, "hi");
+    await until(app, "working");
+    await press(app, "\u001bp");
+    expect(app.lastFrame()).toContain("/model\n");
+    await press(app, "\u001b"); // stops the turn; the queue goes on
+    await until(app, "fake:b");
+  });
+
+  it("prints the last turn's tool calls on Ctrl+O, and before any turn says there is none", async () => {
+    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")]);
+    await press(app, "\u000f");
+    expect(app.lastFrame()).toContain("No turn yet, so no tool calls to show.");
+    await writeFile(path.join(ctx.root, "a.txt"), "hello there");
+    await type(app, "go");
+    await until(app, "done");
+    await press(app, "\u000f");
+    expect(app.lastFrame()).toContain('Last turn: 1 tool call\n● read_file {\n  "path": "a.txt"\n}\n  ⎿ ');
+    expect(app.lastFrame()).toMatch(/⎿ [^\n]*hello there/);
+  });
+});
```

**Change `tests/tui/keys.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/keys.test.ts b/tests/tui/keys.test.ts
index 2268aa9..2d00d2f 100644
--- a/tests/tui/keys.test.ts
+++ b/tests/tui/keys.test.ts
@@ -89,3 +89,15 @@ describe("commands", () => {
     expect(commands("a\u0007b", key())).toEqual([{ type: "insert", text: "ab" }]);
   });
 });
+
+describe("commands for the modes, the model list and the last turn", () => {
+  it("switches the permission mode on Shift+Tab, which arrives as Tab with Shift", () => {
+    expect(commands("", key({ tab: true, shift: true }))).toEqual(["mode"]);
+    expect(commands("", key({ tab: true }))).toEqual([]); // Tab alone is the menus'
+  });
+
+  it("opens the model list on Alt+P, and shows the last turn's tool calls on Ctrl+O", () => {
+    expect(commands("p", key({ meta: true }))).toEqual(["models"]);
+    expect(commands("o", key({ ctrl: true }))).toEqual(["lastTurn"]);
+  });
+});
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index 18aee9a..40f6045 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -1,6 +1,6 @@
 import { render } from "ink-testing-library";
 import { describe, expect, it, vi } from "vitest";
-import { describe as describeMessage, screen } from "../../src/tui/describe.js";
+import { describe as describeMessage, lastTurn, screen } from "../../src/tui/describe.js";
 import { contextBar, duration, formatSegment, type Segment, SEGMENTS, type StatusInfo, StatusLine } from "../../src/tui/StatusLine.js";
 
 const info: StatusInfo = {
@@ -129,6 +129,38 @@ describe("describe", () => {
   });
 });
 
+describe("lastTurn", () => {
+  it("says there is none before any turn", () => {
+    expect(lastTurn([])).toEqual([{ text: "No turn yet, so no tool calls to show.", color: "gray" }]);
+  });
+
+  it("shows the latest turn's tool calls only, each with its full input and result, grey", () => {
+    const lines = lastTurn([
+      { role: "user", parts: [{ type: "text", text: "one" }] },
+      { role: "assistant", parts: [{ type: "tool_call", id: "c0", name: "shell", input: { command: "old" } }] },
+      { role: "user", parts: [{ type: "tool_result", callId: "c0", output: "old", isError: false }] },
+      { role: "user", parts: [{ type: "text", text: "two" }] },
+      { role: "assistant", parts: [{ type: "text", text: "reading" }, { type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }] },
+      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "line 1\nline 2", isError: false }] },
+      { role: "assistant", parts: [{ type: "tool_call", id: "c2", name: "shell", input: { command: "npm test" } }] },
+    ]);
+    expect(lines).toEqual([
+      { text: "Last turn: 2 tool calls", color: "gray" },
+      { text: '● read_file {\n  "path": "a"\n}\n  ⎿ line 1\nline 2', color: "gray" },
+      { text: '● shell {\n  "command": "npm test"\n}\n  ⎿ (not finished)', color: "gray" }, // the turn is still running
+    ]);
+  });
+
+  it("is cleaned of escape codes when shown, like every scrollback line", () => {
+    const [, call] = lastTurn([
+      { role: "user", parts: [{ type: "text", text: "go" }] },
+      { role: "assistant", parts: [{ type: "tool_call", id: "c", name: "shell", input: {} }] },
+      { role: "user", parts: [{ type: "tool_result", callId: "c", output: "a\u001b]52;c;eA==\u0007", isError: true }] },
+    ]);
+    expect(screen(call!).text).toBe("● shell {}\n  ⎿ a\\u001b]52;c;eA==\\u0007");
+  });
+});
+
 describe("screen", () => {
   it("keeps line breaks and tabs in prose, and escapes everything else", () => {
     expect(screen({ text: "a\tb\r\nc\rd\n\u001b]52;c;eA==\u0007" }).text).toBe("a\tb\nc␍d\n\\u001b]52;c;eA==\\u0007");
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/core/permissions.test.ts tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 3 failed | 1 passed (4); Tests 11 failed | 147 passed (158). None of these keys does anything yet.

**Step 3: Write the code**

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 010dba5..1b81285 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -188,6 +188,9 @@ if (parsed.print !== undefined) {
       bus={bus}
       stats={stats}
       mode={mode}
+      onMode={(m) => {
+        gate.mode = m;
+      }}
       project={path.basename(root) || root}
       root={root}
       gitBranch={() => gitBranch(root)}
```

**Change `src/core/permissions.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/permissions.ts b/src/core/permissions.ts
index 18d3907..51c8f17 100644
--- a/src/core/permissions.ts
+++ b/src/core/permissions.ts
@@ -37,7 +37,7 @@ export class Declined extends Error {}
 
 export class PermissionGate {
   constructor(
-    readonly mode: Mode,
+    public mode: Mode, // read at each check: Shift+Tab changes it during a session
     private readonly ask: (summary: string, detail?: string) => Promise<boolean>,
     private readonly refusal = "The user declined", // what the model is told; in -p mode nobody was asked
   ) {}
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index d7944e2..5da2c1e 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -7,10 +7,10 @@ import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
-import { describe, type Line, screen } from "./describe.js";
+import { describe, lastTurn, type Line, screen } from "./describe.js";
 import { apply, type Editor, empty, load, move, replace } from "./editor.js";
 import { History, matches } from "./history.js";
-import { type Command, commands } from "./keys.js";
+import { type Command, commands, KEY_LIST } from "./keys.js";
 import { layout, vertical } from "./layout.js";
 import { Menu } from "./Menu.js";
 import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu } from "./menus.js";
@@ -24,7 +24,8 @@ export interface AppProps {
   session: Session;
   bus: Bus;
   stats: Stats;
-  mode: Mode;
+  mode: Mode; // the mode the session started in
+  onMode: (mode: Mode) => void; // Shift+Tab: the mode the permission check uses from the next action
   project: string; // the project folder's name, for the status line
   root: string; // the project folder, where `@` paths start
   gitBranch: () => string | null; // read at the start and after each turn: the model may switch branches
@@ -48,7 +49,7 @@ const DOUBLE_PRESS_MS = 800; // Claude Code's window for pressing Ctrl+D twice (
 const NAMES = ["/exit", "/errors", "/lead", "/model", "/login", "/logout"];
 const isCommand = (text: string) => NAMES.includes(text.split(/\s+/)[0]!.toLowerCase()) || /^\/[a-z]+$/i.test(text);
 
-export function App({ session, bus, stats, mode, project, root, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
+export function App({ session, bus, stats, mode, onMode, project, root, gitBranch, historyFile, errorFile, segments, makeProvider, bindAsk, login, listModels }: AppProps) {
   const { exit } = useApp();
   const [lines, setLines] = useState<(Line & { id: number })[]>([]);
   // Each key reads and changes these at once, as in ModelPicker: several keys can arrive before the
@@ -68,6 +69,10 @@ export function App({ session, bus, stats, mode, project, root, gitBranch, histo
   const [busy, setBusy] = useState(false);
   const working = useRef(false); // busy, for keys read before the screen is drawn again
   const queue = useRef<string[]>([]); // what Enter added during a turn, in order
+  // Shift+Tab's modes: `never` only for a session started in it, so no key turns off the checks a
+  // session started with.
+  const perm = useRef(mode);
+  const cycle: Mode[] = mode === "never" ? ["ask", "project", "never"] : ["ask", "project"];
   const [question, setQuestion] = useState<Question | null>(null);
   const [contextWindow, setContextWindow] = useState<number | null>(null);
   const [picker, setPicker] = useState<ModelGroup[] | null>(null);
@@ -299,6 +304,16 @@ export function App({ session, bus, stats, mode, project, root, gitBranch, histo
       return;
     }
     if (menu && c === "submit") return menu.kind === "command" ? send(load(e, menu.entries[chosenIn(e, menu)]!.run!)) : fill(menu, e);
+    if (c === "mode") {
+      perm.current = cycle[(cycle.indexOf(perm.current) + 1) % cycle.length]!;
+      onMode(perm.current);
+      return say({ text: `mode is now ${perm.current}`, color: "gray" });
+    }
+    // Alt+P is `/model` typed then: during a turn it waits in the queue.
+    if (c === "models") return working.current ? void queue.current.push("/model") : void submit("/model");
+    if (c === "lastTurn") return say(...lastTurn(session.messages));
+    // A message starting with `?` needs a space typed first.
+    if (typeof c === "object" && c.type === "insert" && c.text === "?" && !e.text) return say(...KEY_LIST.map((text) => ({ text, color: "gray" })));
     if (c === "up" && !e.text && queue.current.length) return restore();
     if (c === "up" || c === "down") {
       const to = vertical(e.text, promptWidth(columns), e.cursor, c === "up" ? -1 : 1, goal.current);
@@ -490,7 +505,7 @@ export function App({ session, bus, stats, mode, project, root, gitBranch, histo
           output: stats.output,
           cost: stats.cost,
           costUnknown: stats.costUnknown,
-          mode,
+          mode: perm.current,
           errors: stats.errors,
           project,
           branch,
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index e9335f4..0c96122 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -31,3 +31,17 @@ export function describe(m: Message): Line[] {
   }
   return lines;
 }
+
+// Ctrl+O: every tool call of the latest turn, from its prompt on, with its full input and result,
+// under a heading. A call of a turn still running may have no result yet.
+export function lastTurn(messages: Message[]): Line[] {
+  const start = messages.findLastIndex((m) => m.role === "user" && m.parts.some((p) => p.type === "text"));
+  if (start === -1) return [{ text: "No turn yet, so no tool calls to show.", color: "gray" }];
+  const parts = messages.slice(start).flatMap((m) => m.parts);
+  const calls = parts.filter((p) => p.type === "tool_call");
+  const results = new Map(parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
+  return [
+    { text: `Last turn: ${calls.length} tool call${calls.length === 1 ? "" : "s"}`, color: "gray" },
+    ...calls.map((c) => ({ text: `● ${c.name} ${JSON.stringify(c.input, null, 2)}\n  ⎿ ${results.get(c.id) ?? "(not finished)"}`, color: "gray" })),
+  ];
+}
```

**Change `src/tui/keys.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/keys.ts b/src/tui/keys.ts
index a4894ec..14c4646 100644
--- a/src/tui/keys.ts
+++ b/src/tui/keys.ts
@@ -3,13 +3,29 @@ import type { Action } from "./editor.js";
 
 // What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
 // user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
-// needs the screen's width, so App does them.
-export type Command = Action | "submit" | "up" | "down" | "search";
+// needs the screen's width, so App does them, and the rest of these App's own: Ctrl+R's search,
+// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes").
+export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn";
 
 // Ink names a key held with Ctrl or Alt by its letter.
 // Ctrl+P and Ctrl+N are Up and Down, as in Claude Code.
-const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search" };
-const ALT: Record<string, Action> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };
+const CTRL: Record<string, Command> = { a: "home", e: "end", d: "delete", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank", z: "undo", p: "up", n: "down", r: "search", o: "lastTurn" };
+const ALT: Record<string, Command> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter", p: "models" };
+
+// What `?` on an empty prompt prints, grey, in the scrollback.
+export const KEY_LIST = [
+  "Keys:",
+  "  Enter  send · Shift+Enter, \\ then Enter, or Ctrl+J  new line",
+  "  Esc  stop the turn · Esc Esc  clear the prompt",
+  "  Ctrl-C  stop the turn and take back the queue, or clear the prompt · twice when empty  exit",
+  "  Ctrl-D twice on an empty prompt  exit",
+  "  ↑ ↓ or Ctrl+P Ctrl+N  past prompts (↑ takes back a queue) · Ctrl+R  search them",
+  "  Home End or Ctrl+A Ctrl+E  line start, end · Alt+B Alt+F or Ctrl+← Ctrl+→  by word",
+  "  Ctrl+W  delete back to a space · Alt+Backspace  the word before · Alt+D  the word after",
+  "  Ctrl+K  delete to the line's end · Ctrl+U  to its start · Ctrl+Y  put it back · Ctrl+Z  undo",
+  "  /  commands · @  project paths · Shift+Tab  permission mode · Alt+P  pick the model",
+  "  Ctrl+O  the last turn's tool calls in full · a space first starts a message with ?",
+];
 
 export function commands(input: string, key: Key): Command[] {
   if (key.return) return [key.shift ? "newline" : "submit"]; // Shift+Enter only where the terminal tells it apart
@@ -22,6 +38,7 @@ export function commands(input: string, key: Key): Command[] {
   // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
   if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
   if (key.delete) return ["delete"];
+  if (key.tab && key.shift) return ["mode"];
   if (key.ctrl) return CTRL[input] ? [CTRL[input]] : [];
   if (key.meta) return ALT[input] ? [ALT[input]] : [];
   if (input === "\u001f") return ["undo"]; // Ctrl+_
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 33 passed | 2 skipped (35); Tests 539 passed | 7 skipped (546).

**Step 5: Commit**

```bash
git add src/cli.tsx src/core/permissions.ts src/tui/App.tsx src/tui/describe.ts src/tui/keys.ts tests/core/permissions.test.ts tests/tui/app.test.tsx tests/tui/keys.test.ts tests/tui/statusline.test.tsx
git commit -m "feat: ? lists the keys, Shift+Tab switches the permission mode, Alt+P opens the model list, Ctrl+O prints the last turn's tool calls"
```

### Task 13: The working line, one-line tool calls, and the tool line

The design's "On screen":
- **`src/tui/WorkingLine.tsx`** replaces "… working (Ctrl-C to stop)":
  `⠋ Working · 1m 12s · ↓ 2.3k tokens · $0.04 · Esc to stop`. The time, tokens and cost are this
  turn's; the cost follows the status line's rules (`costText()`, taken out of `StatusLine.tsx`).
  The label says what is running: "Working", "Waiting for the browser" for `/login`, "Signing out"
  for `/logout`, "Reading the model lists" for `/model`. The spinner moves every 80 ms.
- **A tool call's line** shows its main detail (`brief()` in `describe.ts`): `● read_file src/x.ts`,
  `● shell npm test`. A tool without its own summary keeps its whole input.
- **`src/tui/ToolLine.tsx`,** a line under the status line, from Task 1's events: the running call
  and its target, then the turn's finished calls counted by tool, `✓` for done, `✗` red for failed,
  `⊘` grey for declined or cancelled, the four most used. It keeps the last turn's counts until the
  next turn starts, and is the first line dropped when the terminal is too short. `--status` takes
  `tools`.

`Stats` counts the calls with no known price, so a turn can tell whether its own cost is known. The
tests that waited for "working" now wait for "Esc to stop", which every label ends with. Choice 10
covers the rest.

**Files:**
- Modify: `src/core/stats.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/StatusLine.tsx`
- Create: `src/tui/ToolLine.tsx`
- Create: `src/tui/WorkingLine.tsx`
- Modify: `src/tui/describe.ts`
- Modify: `tests/clilib.test.ts`
- Modify: `tests/core/errorlog.test.ts`
- Modify: `tests/tui/app.test.tsx`
- Create: `tests/tui/lines.test.tsx`
- Modify: `tests/tui/statusline.test.tsx`

**Step 1: Write the failing tests**

**Change `tests/clilib.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/clilib.test.ts b/tests/clilib.test.ts
index fbe76fe..b691821 100644
--- a/tests/clilib.test.ts
+++ b/tests/clilib.test.ts
@@ -71,7 +71,7 @@ describe("statusSegments", () => {
   });
 
   it("names --status when a segment is unknown", () => {
-    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time (got "nope")');
+    expect(() => statusSegments("lead,nope")).toThrow('--status must be one of: lead, context, tokens, cost, mode, errors, project, time, tools (got "nope")');
   });
 });
 
```

**Change `tests/core/errorlog.test.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/core/errorlog.test.ts b/tests/core/errorlog.test.ts
index cd539ce..81a952b 100644
--- a/tests/core/errorlog.test.ts
+++ b/tests/core/errorlog.test.ts
@@ -129,6 +129,16 @@ describe("Stats", () => {
     expect(stats.costUnknown).toBe(true);
   });
 
+  it("counts the calls without a known price, so a turn can tell its own", () => {
+    const bus = new Bus();
+    const stats = new Stats(bus);
+    const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
+    bus.emit("usage", { provider: "openai:unknown", usage });
+    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage, priceKnown: false });
+    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage });
+    expect(stats.unpriced).toBe(2);
+  });
+
   it("does not count a rescued refusal as an error", () => {
     const bus = new Bus();
     const stats = new Stats(bus);
```

**Change `tests/tui/app.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/app.test.tsx b/tests/tui/app.test.tsx
index d458f16..28d3053 100644
--- a/tests/tui/app.test.tsx
+++ b/tests/tui/app.test.tsx
@@ -177,7 +177,7 @@ describe("App", () => {
     await until(app, `Allow write ${target}? [y/n]`);
     app.stdin.write("\u0003");
     await until(app, `write ${target}: declined (cancelled)`);
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
     expect(app.lastFrame()).not.toContain("[y/n]");
     expect(app.lastFrame()).not.toContain("written");
     expect(existsSync(target)).toBe(false);
@@ -186,9 +186,9 @@ describe("App", () => {
   it("says no at once, without a prompt, when asked after the turn was cancelled", async () => {
     const { app, ask } = await mount([], { lead: hanging() });
     await type(app, "hi");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     app.stdin.write("\u0003");
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
     const answer = await Promise.race([ask("write x"), tick().then(() => "still waiting")]);
     expect(answer).toBe(false);
     expect(app.lastFrame()).not.toContain("[y/n]");
@@ -288,10 +288,10 @@ describe("App", () => {
     const login: Login = (_verb, _words, _say, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Sign-in was cancelled"))));
     const { app } = await mount([], { login });
     await type(app, "/login chatgpt");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     app.stdin.write("\u0003");
     await until(app, "Sign-in was cancelled");
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
   });
 
   const models: ModelGroup[] = [
@@ -420,9 +420,9 @@ describe("App", () => {
   it("stops reading the lists on Ctrl-C, without opening the picker", async () => {
     const { app } = await mount([], { models, slow: true });
     await type(app, "/model");
-    await until(app, "Ctrl-C to stop");
+    await until(app, "Esc to stop");
     app.stdin.write("\u0003");
-    await gone(app, "Ctrl-C to stop");
+    await gone(app, "Esc to stop");
     await tick();
     expect(app.lastFrame()).not.toContain("fake:c");
     expect(app.lastFrame()).not.toContain("Filter:");
@@ -665,9 +665,9 @@ describe("App's keys for stopping and exiting", () => {
   it("stops a turn on Esc, keeping what was done so far", async () => {
     const { app } = await mount([], { lead: hanging() });
     await type(app, "hi");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "\u001b");
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
     expect(app.lastFrame()).toContain("> hi");
   });
 
@@ -748,7 +748,7 @@ describe("App's keys for stopping and exiting", () => {
     const { app } = await mount([], { lead: hanging() });
     expect(app.lastFrame()).toContain("? for shortcuts");
     await type(app, "hi");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     expect(app.lastFrame()).not.toContain("? for shortcuts");
   });
 });
@@ -871,9 +871,9 @@ describe("App's queue", () => {
     const { lead, release } = gated([reply("r1"), reply("r2")]);
     const { app, session, historyFile } = await mount([], { lead });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r", "three", "\r", "fo");
-    expect(app.lastFrame()).toMatch(/working[^\n]*\ntwo\nthree\n› fo\n↑ to edit queued messages\n/);
+    expect(app.lastFrame()).toMatch(/Esc to stop\ntwo\nthree\n› fo\n↑ to edit queued messages\n/);
     release();
     await until(app, "r2");
     expect(prompts(session)).toEqual(["one", "two\n\nthree"]);
@@ -886,8 +886,8 @@ describe("App's queue", () => {
     const { lead, release } = gated([reply("r1"), reply("r2")]);
     const { app, session } = await mount([], { lead });
     app.stdin.write("one\rtwo\r");
-    await until(app, "working");
-    expect(app.lastFrame()).toMatch(/working[^\n]*\ntwo\n›/);
+    await until(app, "Esc to stop");
+    expect(app.lastFrame()).toMatch(/Esc to stop\ntwo\n›/);
     release();
     await until(app, "r2");
     expect(prompts(session)).toEqual(["one", "two"]);
@@ -909,7 +909,7 @@ describe("App's queue", () => {
     const b = new FakeProvider("b", [reply("from b")]);
     const { app, session } = await mount([], { lead, newLead: b });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r", "/lead fake:b", "\r", "three", "\r");
     release();
     await until(app, "from b");
@@ -923,7 +923,7 @@ describe("App's queue", () => {
     const { lead, release } = gated([new Error("boom"), reply("last")]);
     const { app, session } = await mount([], { lead });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r", "/lead", "\r", "three", "\r", "\u001b");
     await until(app, "last");
     release();
@@ -934,9 +934,9 @@ describe("App's queue", () => {
   it("brings the queue back into the prompt on Ctrl-C, after what is typed, one entry a line, and sends nothing more", async () => {
     const { app, session } = await mount([], { lead: hanging() });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r", "three", "\r", "draft", "\u0003");
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
     expect(app.lastFrame()).toContain("› draft\n  two\n  three\n? for shortcuts");
     await tick();
     expect(prompts(session)).toEqual(["one"]);
@@ -946,12 +946,12 @@ describe("App's queue", () => {
     const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" })]);
     const { app, ctx } = await mount([], { lead });
     await type(app, "make a file");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r");
     release();
     await until(app, `Allow write ${path.join(ctx.root, "a.txt")}?`);
     await press(app, "\u0003");
-    await gone(app, "working");
+    await gone(app, "Esc to stop");
     expect(app.lastFrame()).toContain("› two\n? for shortcuts");
   });
 
@@ -959,7 +959,7 @@ describe("App's queue", () => {
     const { lead, release } = gated([reply("r1"), reply("r2")]);
     const { app, session } = await mount([], { lead });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "/exit", "\r", "two", "\r");
     release();
     await vi.waitFor(() => expect(session.messages.at(-1)?.role).toBe("assistant")); // the screen is gone once it exits
@@ -972,7 +972,7 @@ describe("App's queue", () => {
     const { lead, release } = gated([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("done")]);
     const { app } = await mount([], { lead });
     await type(app, "make a file");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r");
     expect(app.lastFrame()).toContain("↑ to edit queued messages");
     release();
@@ -984,7 +984,7 @@ describe("App's queue", () => {
     const { lead, release } = gated([reply("r1"), reply("r2")]);
     const { app, session } = await mount([], { lead, models: [{ provider: "fake", models: ["a", "c"] }] });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "/model", "\r", "two", "\r");
     release();
     await until(app, "fake:c");
@@ -998,7 +998,7 @@ describe("App's queue", () => {
   it("takes the queue back on Up from an empty prompt", async () => {
     const { app } = await mount([], { lead: hanging(), past: ["old"] });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "two", "\r", "three", "\r", "\u001b[A");
     expect(app.lastFrame()).toContain("› two\n  three\n");
     expect(app.lastFrame()).not.toContain("queued");
@@ -1026,11 +1026,11 @@ describe("App's space on screen", () => {
   it("gives the queue the rows the prompt leaves, the last saying how many more, or the hint line the count", async () => {
     const { app } = await mount([], { lead: hanging(), rows: 8 });
     await type(app, "one");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     for (const q of ["q1", "q2", "q3", "q4", "q5"]) await press(app, q, "\r");
-    expect(app.lastFrame()).toMatch(/working[^\n]*\nq1\nq2\n\+3 more\n›\n↑ to edit queued messages\n[^\n]*$/);
+    expect(app.lastFrame()).toMatch(/Esc to stop\nq1\nq2\n\+3 more\n›\n↑ to edit queued messages\n[^\n]*$/);
     await press(app, "a", "\n", "b", "\n", "c", "\n", "d"); // four rows: none left for the queue
-    expect(app.lastFrame()).toMatch(/working[^\n]*\n› a\n  b\n  c\n  d\n5 queued\n[^\n]*$/);
+    expect(app.lastFrame()).toMatch(/Esc to stop\n› a\n  b\n  c\n  d\n5 queued\n[^\n]*$/);
   });
 
   it("drops the hint line when the terminal is too short for it and the cursor's row", async () => {
@@ -1176,7 +1176,7 @@ describe("App's keys for the modes, the model list and the last turn", () => {
   it("queues the model list on Alt+P during a turn, as /model typed then", async () => {
     const { app } = await mount([], { lead: hanging(), models: [{ provider: "fake", models: ["a", "b"] }] });
     await type(app, "hi");
-    await until(app, "working");
+    await until(app, "Esc to stop");
     await press(app, "\u001bp");
     expect(app.lastFrame()).toContain("/model\n");
     await press(app, "\u001b"); // stops the turn; the queue goes on
@@ -1195,3 +1195,89 @@ describe("App's keys for the modes, the model list and the last turn", () => {
     expect(app.lastFrame()).toMatch(/⎿ [^\n]*hello there/);
   });
 });
+
+describe("App's working line and tool lines", () => {
+  it("shows what is running, for how long, and the turn's tokens and cost, the spinner moving", async () => {
+    const { app } = await mount([], { lead: hanging() });
+    await type(app, "hi");
+    await until(app, "Esc to stop");
+    expect(app.lastFrame()).toMatch(/\n. Working · 0s · ↓ 0 tokens · \$0\.00 · Esc to stop\n/);
+    const spinners = new Set<string>();
+    for (let i = 0; i < 6; i++, await tick()) spinners.add(/\n(.) Working/.exec(app.lastFrame()!)![1]!);
+    expect(spinners.size).toBeGreaterThan(1); // 300 ms: a few of its 80 ms steps
+    await until(app, " Working · 1s · ");
+  });
+
+  it("names what it waits for: the browser for /login, signing out for /logout, the model lists for /model", async () => {
+    const login: Login = (_verb, _words, _say, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
+    const { app } = await mount([], { login, slow: true });
+    await type(app, "/login chatgpt");
+    await until(app, "Waiting for the browser");
+    expect(app.lastFrame()).toMatch(/Waiting for the browser · \d+s · Esc to stop/);
+    await press(app, "\u001b");
+    await gone(app, "Esc to stop");
+    await type(app, "/logout chatgpt");
+    await until(app, "Signing out");
+    expect(app.lastFrame()).toMatch(/Signing out · \d+s · Esc to stop/);
+    await press(app, "\u001b");
+    await gone(app, "Esc to stop");
+    await type(app, "/model");
+    await until(app, "Reading the model lists");
+    expect(app.lastFrame()).toMatch(/Reading the model lists · \d+s · Esc to stop/);
+  });
+
+  it("shows a call's main detail, and counts the turn's calls under the status line until the next turn starts", async () => {
+    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), callTool("c2", "read_file", { path: "a.txt" }), reply("done"), reply("again")]);
+    await writeFile(path.join(ctx.root, "a.txt"), "x");
+    await type(app, "go");
+    await until(app, "done");
+    expect(app.lastFrame()).toContain("● read_file a.txt\n");
+    expect(app.lastFrame()).toMatch(/⏱[^\n]*\n✓ read_file ×2$/);
+    await type(app, "more");
+    await until(app, "again");
+    expect(app.lastFrame()).not.toContain("✓ read_file");
+  });
+
+  it("shows the running call with its target, and a declined one under ⊘", async () => {
+    const { app } = await mount([callTool("c1", "write_file", { path: "a.txt", content: "x" }), reply("written")]);
+    await type(app, "go");
+    await until(app, "Allow");
+    expect(app.lastFrame()).toMatch(/\n◐ write_file a\.txt$/);
+    await press(app, "n");
+    await until(app, "written");
+    expect(app.lastFrame()).toMatch(/\n⊘ write_file ×1$/);
+  });
+
+  it("has no tool line when --status leaves tools out", async () => {
+    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { segments: SEGMENTS.filter((s) => s !== "tools") });
+    await writeFile(path.join(ctx.root, "a.txt"), "x");
+    await type(app, "go");
+    await until(app, "done");
+    expect(app.lastFrame()).not.toContain("✓ read_file");
+  });
+
+  it("hides the tool line while the model list is open, which fills the rows above the status line", async () => {
+    const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { rows: 8, models: [{ provider: "fake", models: ["a", "b", "c", "d", "e", "f"] }] });
+    await writeFile(path.join(ctx.root, "a.txt"), "x");
+    await type(app, "go");
+    await until(app, "done");
+    expect(app.lastFrame()).toContain("✓ read_file ×1");
+    await type(app, "/model");
+    await until(app, "fake:a");
+    expect(app.lastFrame()).not.toContain("✓ read_file");
+    await tick(); // the picker starts reading keys just after it first appears
+    await press(app, "\u001b");
+    await until(app, "✓ read_file ×1");
+  });
+
+  it("drops the tool line first when the terminal is too short", async () => {
+    for (const [rows, shown] of [[4, false], [5, true]] as const) {
+      const { app, ctx } = await mount([callTool("c1", "read_file", { path: "a.txt" }), reply("done")], { rows });
+      await writeFile(path.join(ctx.root, "a.txt"), "x");
+      await type(app, "go");
+      await until(app, "done");
+      expect(app.lastFrame()!.includes("✓ read_file ×1")).toBe(shown);
+      expect(app.lastFrame()).toContain("? for shortcuts");
+    }
+  });
+});
```

**Create `tests/tui/lines.test.tsx`:**

```tsx
import { describe, expect, it } from "vitest";
import type { ToolOutcome } from "../../src/core/bus.js";
import { toolParts } from "../../src/tui/ToolLine.js";
import { workingText } from "../../src/tui/WorkingLine.js";

describe("workingText", () => {
  const spend = { lead: "anthropic:claude-opus-5-5", output: 0, cost: 0, costUnknown: false };

  it("shows the label, the turn's time in seconds, its tokens and cost, and Esc, the spinner moving every 80 ms", () => {
    expect(workingText("Working", 0, spend)).toBe("⠋ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 80, spend)).toBe("⠙ Working · 0s · ↓ 0 tokens · $0.00 · Esc to stop");
    expect(workingText("Working", 72_400, { ...spend, output: 2_345, cost: 0.0412 })).toBe("⠴ Working · 1m 12s · ↓ 2.3k tokens · $0.04 · Esc to stop");
  });

  it("follows the status line's rules for the cost: the ChatGPT plan, and a model without a price", () => {
    expect(workingText("Working", 1_000, { ...spend, lead: "chatgpt:gpt-6.1-sol" })).toBe("⠹ Working · 1s · ↓ 0 tokens · ChatGPT plan · Esc to stop");
    expect(workingText("Working", 1_000, { ...spend, lead: "ollama:x", costUnknown: true })).toBe("⠹ Working · 1s · ↓ 0 tokens · $0.00 + ? · Esc to stop");
  });

  it("leaves out tokens and cost for what is not a turn", () => {
    expect(workingText("Waiting for the browser", 5_000, null)).toBe("⠹ Waiting for the browser · 5s · Esc to stop");
  });
});

describe("toolParts", () => {
  let n = 0;
  const call = (name: string, outcome?: ToolOutcome, target: string | null = null) => ({ id: `c${n++}`, name, target, ...(outcome ? { outcome } : {}) });
  const shown = (calls: ReturnType<typeof call>[]) => toolParts(calls).map((p) => `${p.mark} ${p.rest}`);

  it("shows the running call with its target, then the finished ones counted by tool and how they ended, most first, four at most", () => {
    const calls = [
      call("edit_file", "ok"),
      call("read_file", "ok"),
      call("read_file", "ok"),
      call("shell", "failed"),
      call("read_file", "ok"),
      call("write_file", "declined"),
      call("shell", "cancelled"),
      call("shell", undefined, "npm test"),
    ];
    expect(shown(calls)).toEqual(["◐ shell npm test", "✓ read_file ×3", "✓ edit_file ×1", "✗ shell ×1", "⊘ write_file ×1"]);
    expect(toolParts(calls).map((p) => [p.color, p.whole])).toEqual([["yellow", false], ["green", false], ["green", false], ["red", true], ["gray", true]]);
  });

  it("escapes what the model named, and has nothing to show with no calls", () => {
    expect(shown([call("x\u001b[2J", undefined, "a\rb")])).toEqual(["◐ x\\u001b[2J a␍b"]);
    expect(toolParts([])).toEqual([]);
  });
});
```

**Change `tests/tui/statusline.test.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/tests/tui/statusline.test.tsx b/tests/tui/statusline.test.tsx
index 40f6045..cc3f0b3 100644
--- a/tests/tui/statusline.test.tsx
+++ b/tests/tui/statusline.test.tsx
@@ -28,7 +28,7 @@ function frame(i: StatusInfo, segments: Segment[]) {
 
 describe("StatusLine", () => {
   it("shows every part by default", () => {
-    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time"]);
+    expect(SEGMENTS).toEqual(["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tools"]);
     // In two parts: all of them are wider than the test terminal's 100 columns.
     const shown = frame(info, SEGMENTS.slice(0, 4));
     expect(shown).toContain("lead anthropic:claude-opus-5-5");
@@ -119,6 +119,16 @@ describe("describe", () => {
     expect(lines.map(screen)).toEqual([{ text: "  ⎿ exit code: 1", color: "red", oneLine: true }]);
   });
 
+  it("shows a call's main detail: the path for the file tools, the command's first line for shell", () => {
+    const shown = (name: string, input: unknown) => describeMessage({ role: "assistant", parts: [{ type: "tool_call", id: "c", name, input }] })[0]!.text;
+    expect(shown("read_file", { path: "src/x.ts", offset: 5 })).toBe("● read_file src/x.ts");
+    expect(shown("write_file", { path: "src/x.ts", content: "a" })).toBe("● write_file src/x.ts");
+    expect(shown("edit_file", { path: "src/x.ts", old_text: "a", new_text: "b" })).toBe("● edit_file src/x.ts");
+    expect(shown("shell", { command: "npm test\necho done" })).toBe("● shell npm test");
+    expect(shown("x", { s: 1 })).toBe('● x {"s":1}'); // a tool without its own summary
+    expect(shown("shell", { command: 5 })).toBe('● shell {"command":5}'); // nothing it can summarise
+  });
+
   it("does not show an unknown kind of part as a tool result", () => {
     expect(describeMessage({ role: "assistant", parts: [{ type: "thinking" } as never] })).toEqual([]);
   });
```


**Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/clilib.test.ts tests/core/errorlog.test.ts tests/tui/app.test.tsx tests/tui/lines.test.tsx tests/tui/statusline.test.tsx`

Expected: FAIL. In the scratch build: Test Files 5 failed (5); Tests 27 failed | 124 passed (151). `src/tui/WorkingLine.tsx` and `src/tui/ToolLine.tsx` do not exist yet.

**Step 3: Write the code**

**Change `src/core/stats.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/core/stats.ts b/src/core/stats.ts
index 9014df7..82e4495 100644
--- a/src/core/stats.ts
+++ b/src/core/stats.ts
@@ -6,7 +6,7 @@ export class Stats {
   input = 0; // all prompt tokens sent, cached or not
   output = 0;
   cost = 0; // USD, for calls whose price is known
-  costUnknown = false; // true once any call had no known price
+  unpriced = 0; // calls with no known price
   context = 0; // size of the most recent request plus its reply
   errors = 0; // a refusal another model answered is not one
 
@@ -17,11 +17,15 @@ export class Stats {
       this.output += usage.output;
       this.context = prompt + usage.output;
       const c = priceKnown === false ? null : cost(provider, usage);
-      if (c === null) this.costUnknown = true;
+      if (c === null) this.unpriced++;
       else this.cost += c;
     });
     bus.on("error", (e) => {
       if (e.kind !== "fallback") this.errors++;
     });
   }
+
+  get costUnknown(): boolean {
+    return this.unpriced > 0;
+  }
 }
```

**Change `src/tui/App.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/App.tsx b/src/tui/App.tsx
index 5da2c1e..fc6ebeb 100644
--- a/src/tui/App.tsx
+++ b/src/tui/App.tsx
@@ -1,13 +1,13 @@
 import { type Key, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
 import { useEffect, useRef, useState } from "react";
-import type { Bus, ErrorEvent } from "../core/bus.js";
+import type { Bus, ErrorEvent, Events } from "../core/bus.js";
 import { summarize } from "../core/errorlog.js";
 import { type Mode, visible } from "../core/permissions.js";
 import type { Session } from "../core/session.js";
 import type { Stats } from "../core/stats.js";
 import { errorText, type Message, type Provider } from "../core/types.js";
 import type { ModelGroup } from "../providers/models.js";
-import { describe, lastTurn, type Line, screen } from "./describe.js";
+import { brief, describe, lastTurn, type Line, screen } from "./describe.js";
 import { apply, type Editor, empty, load, move, replace } from "./editor.js";
 import { History, matches } from "./history.js";
 import { type Command, commands, KEY_LIST } from "./keys.js";
@@ -17,6 +17,8 @@ import { commandMenu, type Listing, listFolder, type Menu as MenuData, pathMenu
 import { ModelPicker } from "./ModelPicker.js";
 import { Prompt, promptWidth } from "./Prompt.js";
 import { type Segment, StatusLine } from "./StatusLine.js";
+import { type Call, ToolLine } from "./ToolLine.js";
+import { SPIN_MS, WorkingLine } from "./WorkingLine.js";
 
 type Question = { text: string; answer: (ok: boolean, how: string) => void };
 
@@ -69,6 +71,10 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
   const [busy, setBusy] = useState(false);
   const working = useRef(false); // busy, for keys read before the screen is drawn again
   const queue = useRef<string[]>([]); // what Enter added during a turn, in order
+  // What is running, since when, and for a turn the totals it started from; and the turn's tool calls,
+  // kept after it until the next turn starts.
+  const doing = useRef<{ label: string; at: number; from: { output: number; cost: number; unpriced: number } | null }>({ label: "", at: 0, from: null });
+  const calls = useRef<Call[]>([]);
   // Shift+Tab's modes: `never` only for a session started in it, so no key turns off the checks a
   // session started with.
   const perm = useRef(mode);
@@ -137,10 +143,21 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       say({ text: `lead is now ${id}`, color: "magenta" });
       lookUpWindow();
     };
+    const onToolStart = ({ id, name, input }: Events["tool-start"][0]) => {
+      calls.current.push({ id, name, target: brief(name, input) });
+      rerender((n) => n + 1);
+    };
+    const onToolEnd = ({ id, outcome }: Events["tool-end"][0]) => {
+      const call = calls.current.find((c) => c.id === id);
+      if (call) call.outcome = outcome;
+      rerender((n) => n + 1);
+    };
     bus.on("message", onMessage);
     bus.on("error", onError);
     bus.on("usage", onUsage);
     bus.on("lead", onLead);
+    bus.on("tool-start", onToolStart);
+    bus.on("tool-end", onToolEnd);
     history.current!.load();
     lookUpWindow();
     const minutes = setInterval(() => setNow(Date.now()), 60_000); // the status line counts the session in minutes
@@ -151,9 +168,18 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       bus.off("error", onError);
       bus.off("usage", onUsage);
       bus.off("lead", onLead);
+      bus.off("tool-start", onToolStart);
+      bus.off("tool-end", onToolEnd);
     };
   }, []);
 
+  // The working line's spinner and time, while something runs.
+  useEffect(() => {
+    if (!busy) return;
+    const spin = setInterval(() => setNow(Date.now()), SPIN_MS);
+    return () => clearInterval(spin);
+  }, [busy]);
+
   // Called without await, so nothing may escape: an unhandled rejection ends the program. The queue
   // goes on after a turn, however it ended, and after `/model` once the list is closed.
   const submit = async (raw: string) => {
@@ -192,6 +218,11 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
       if (!account && !alone("/model") && /^\/[a-z]+$/i.test(text)) return say({ text: `Unknown command: ${text}. Commands: ${COMMANDS}`, color: "red" });
       if (words.length && ["/exit", "/errors", "/model"].includes(command)) return say({ text: `${command} takes nothing after it.`, color: "red" });
       abort.current = new AbortController();
+      const turn = !account && !alone("/model");
+      const label = account === "login" ? "Waiting for the browser" : account ? "Signing out" : turn ? "Working" : "Reading the model lists";
+      doing.current = { label, at: Date.now(), from: turn ? { output: stats.output, cost: stats.cost, unpriced: stats.unpriced } : null };
+      if (turn) calls.current = [];
+      setNow(doing.current.at);
       setBusy(true);
       working.current = true;
       try {
@@ -452,10 +483,14 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
 
   // The prompt's space (release 3 design): the live part stays a row shorter than the terminal, since
   // at full height Ink draws the whole scrollback again each time. First the status line and the
-  // working line, and the hint line when there is room for it and the cursor's row; then an open menu,
-  // with the prompt cut to the cursor's row; then the prompt; then the queue, the last row saying how
-  // many more there are when they do not all fit.
-  const room = height - 1 - 1 - (busy ? 1 : 0);
+  // working line; the tool line when there is room for it, the hint line and the cursor's row; the hint
+  // line when there is room for it and the cursor's row; then an open menu, with the prompt cut to the
+  // cursor's row; then the prompt; then the queue, the last row saying how many more there are when
+  // they do not all fit. The model list fills the rows above the status line itself, so it has no
+  // tool line under it.
+  const base = height - 1 - 1 - (busy ? 1 : 0);
+  const tooled = !picker && segments.includes("tools") && calls.current.length > 0 && base >= 2 + (hintFor(1) !== null ? 1 : 0);
+  const room = base - (tooled ? 1 : 0);
   const hinted = hintFor(1) !== null && room >= 2;
   const space = Math.max(1, room - (hinted ? 1 : 0));
   const menuRows = menu ? Math.min(menu.entries.length, Math.max(1, space - 1)) : 0;
@@ -480,7 +515,13 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
         <Text color="yellow">Allow {question.text}? [y/n] · Esc to decline</Text>
       ) : (
         <>
-          {busy && <Text wrap="truncate-end">… working (Ctrl-C to stop)</Text>}
+          {busy && (
+            <WorkingLine
+              label={doing.current.label}
+              ms={Math.max(0, now - doing.current.at)}
+              spend={doing.current.from && { lead: session.lead.id, output: stats.output - doing.current.from.output, cost: stats.cost - doing.current.from.cost, costUnknown: stats.unpriced > doing.current.from.unpriced }}
+            />
+          )}
           {queued.map((row, i) => (
             <Text key={i} color="gray" wrap="truncate-end">
               {row}
@@ -512,6 +553,7 @@ export function App({ session, bus, stats, mode, onMode, project, root, gitBranc
           elapsed: now - started.current,
         }}
       />
+      {tooled && <ToolLine calls={calls.current} />}
     </>
   );
 }
```

**Change `src/tui/StatusLine.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/StatusLine.tsx b/src/tui/StatusLine.tsx
index 56b284f..bc23329 100644
--- a/src/tui/StatusLine.tsx
+++ b/src/tui/StatusLine.tsx
@@ -1,8 +1,10 @@
 import { Text } from "ink";
 import { visible } from "../core/permissions.js";
 
-export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time";
-export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time"];
+// The status line's parts, and `tools`, the line under it (release 3 design, "On screen").
+export type Segment = "lead" | "context" | "tokens" | "cost" | "mode" | "errors" | "project" | "time" | "tools";
+export const SEGMENTS: Segment[] = ["lead", "context", "tokens", "cost", "mode", "errors", "project", "time", "tools"];
+type LineSegment = Exclude<Segment, "tools">;
 
 export interface StatusInfo {
   lead: string;
@@ -20,7 +22,7 @@ export interface StatusInfo {
 }
 
 // The unit is picked after rounding, so 999,999 shows as 1.0M, not 1000.0k.
-const k = (n: number) => {
+export const k = (n: number) => {
   if (n < 1000) return String(n);
   const thousands = (n / 1000).toFixed(1);
   return Number(thousands) < 1000 ? `${thousands}k` : `${(n / 1_000_000).toFixed(1)}M`;
@@ -45,7 +47,16 @@ export function duration(ms: number): string {
   return `${Math.floor(mins / 60)}h ${mins % 60}m`;
 }
 
-export function formatSegment(s: Segment, i: StatusInfo): string {
+// The cost so far; the working line shows a turn's the same way.
+export function costText(lead: string, cost: number, costUnknown: boolean): string {
+  const dollars = `$${cost.toFixed(2)}${costUnknown ? " + ?" : ""}`;
+  // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
+  if (!lead.startsWith("chatgpt:")) return dollars;
+  if (cost) return `ChatGPT plan + ${dollars}`;
+  return costUnknown ? "ChatGPT plan + ?" : "ChatGPT plan";
+}
+
+export function formatSegment(s: LineSegment, i: StatusInfo): string {
   switch (s) {
     case "lead":
       return `lead ${i.lead}`;
@@ -55,13 +66,8 @@ export function formatSegment(s: Segment, i: StatusInfo): string {
       return i.contextWindow ? `ctx ${Math.max(0, 100 - used(i))}% left` : `ctx ${k(i.context)}`;
     case "tokens":
       return `${k(i.input)} in / ${k(i.output)} out`;
-    case "cost": {
-      const dollars = `$${i.cost.toFixed(2)}${i.costUnknown ? " + ?" : ""}`;
-      // A plan has no per-token price; OpenAI's guidelines ask apps to show that the plan is in use.
-      if (!i.lead.startsWith("chatgpt:")) return dollars;
-      if (i.cost) return `ChatGPT plan + ${dollars}`;
-      return i.costUnknown ? "ChatGPT plan + ?" : "ChatGPT plan";
-    }
+    case "cost":
+      return costText(i.lead, i.cost, i.costUnknown);
     case "mode":
       return `perm ${i.mode}`;
     case "errors":
@@ -77,9 +83,10 @@ export function formatSegment(s: Segment, i: StatusInfo): string {
 // One line, cut at the end to the terminal's width (Ink measures it in columns) instead of wrapping.
 // The text is inverse; the context bar is not, so its filled cells show in their colour.
 export function StatusLine({ info, segments }: { info: StatusInfo; segments: Segment[] }) {
+  const shown = segments.filter((s): s is LineSegment => s !== "tools");
   return (
     <Text wrap="truncate-end">
-      {segments.map((s, n) => {
+      {shown.map((s, n) => {
         const bar = s === "context" && info.contextWindow ? contextBar(used(info)) : null;
         return (
           <Text key={n}>
@@ -93,7 +100,7 @@ export function StatusLine({ info, segments }: { info: StatusInfo; segments: Seg
             )}
             <Text inverse color={s === "errors" && info.errors > 0 ? "red" : undefined}>
               {formatSegment(s, info)}
-              {n === segments.length - 1 ? " " : ""}
+              {n === shown.length - 1 ? " " : ""}
             </Text>
           </Text>
         );
```

**Create `src/tui/ToolLine.tsx`:**

```tsx
import { Text } from "ink";
import { Fragment } from "react";
import type { ToolOutcome } from "../core/bus.js";
import { visible } from "../core/permissions.js";

// A call of the turn, from the session's tool-start and tool-end events; no outcome while it runs.
export interface Call {
  id: string;
  name: string;
  target: string | null; // its main detail (`brief` in describe.ts)
  outcome?: ToolOutcome;
}

export interface Part {
  mark: string;
  rest: string;
  color: "yellow" | "green" | "red" | "gray";
  whole: boolean; // the whole part in its colour, not only the mark
}

const ENDS: Record<ToolOutcome, Omit<Part, "rest">> = {
  ok: { mark: "✓", color: "green", whole: false },
  failed: { mark: "✗", color: "red", whole: true },
  declined: { mark: "⊘", color: "gray", whole: true },
  cancelled: { mark: "⊘", color: "gray", whole: true },
};
const SHOWN = 4; // claude-hud's tools line shows the four most used (`renderToolsLine`, src/render/tools-line.ts, 0.0.4)

// The line under the status line (release 3 design, "On screen", after claude-hud's tools line): the
// running call and its target, then the finished calls counted by tool and how they ended, most
// first. Names and targets come from the model, so they are escaped.
export function toolParts(calls: Call[]): Part[] {
  const running = calls.filter((c) => !c.outcome).map((c): Part => ({ mark: "◐", rest: visible(c.target === null ? c.name : `${c.name} ${c.target}`), color: "yellow", whole: false }));
  const counts = new Map<string, { end: Omit<Part, "rest">; name: string; n: number }>();
  for (const c of calls) {
    if (!c.outcome) continue;
    const end = ENDS[c.outcome];
    const group = counts.get(`${end.mark} ${c.name}`) ?? { end, name: c.name, n: 0 };
    group.n++;
    counts.set(`${end.mark} ${c.name}`, group);
  }
  const done = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, SHOWN)
    .map((g): Part => ({ ...g.end, rest: `${visible(g.name)} ×${g.n}` }));
  return [...running, ...done];
}

export function ToolLine({ calls }: { calls: Call[] }) {
  return (
    <Text wrap="truncate-end">
      {toolParts(calls).map((p, n) => (
        <Fragment key={n}>
          {n ? " | " : ""}
          <Text color={p.whole ? p.color : undefined}>
            <Text color={p.color}>{p.mark}</Text> {p.rest}
          </Text>
        </Fragment>
      ))}
    </Text>
  );
}
```

**Create `src/tui/WorkingLine.tsx`:**

```tsx
import { Text } from "ink";
import { costText, k } from "./StatusLine.js";

// cli-spinners' "dots", at its own 80 ms a frame (sindresorhus/cli-spinners, spinners.json, read
// 2026-10-25). Once a second looked stuck (the user, 2026-10-25).
const FRAMES = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
export const SPIN_MS = 80;

export interface Spend {
  lead: string;
  output: number;
  cost: number;
  costUnknown: boolean;
}

// The line over the prompt while something runs (release 3 design, "On screen"): what it is, for how
// long, and for a turn its tokens and cost so far, which change after each model reply.
export function workingText(label: string, ms: number, spend: Spend | null): string {
  const s = Math.floor(ms / 1000);
  const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const turn = spend ? ` · ↓ ${k(spend.output)} tokens · ${costText(spend.lead, spend.cost, spend.costUnknown)}` : "";
  return `${FRAMES[Math.floor(ms / SPIN_MS) % FRAMES.length]} ${label} · ${time}${turn} · Esc to stop`;
}

export function WorkingLine({ label, ms, spend }: { label: string; ms: number; spend: Spend | null }) {
  return <Text wrap="truncate-end">{workingText(label, ms, spend)}</Text>;
}
```

**Change `src/tui/describe.ts`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/tui/describe.ts b/src/tui/describe.ts
index 0c96122..ceaff85 100644
--- a/src/tui/describe.ts
+++ b/src/tui/describe.ts
@@ -9,6 +9,14 @@ export interface Line {
 
 const firstLine = (s: string) => s.split(/\r?\n/)[0] ?? "";
 
+// A call's main detail (release 3 design, "On screen"): the path for the file tools, the command's
+// first line for shell; null for a tool without its own summary, which is shown with its whole input.
+const DETAIL: Record<string, string> = { read_file: "path", write_file: "path", edit_file: "path", shell: "command" };
+export function brief(name: string, input: unknown): string | null {
+  const value = Object.hasOwn(DETAIL, name) && typeof input === "object" && input !== null ? (input as Record<string, unknown>)[DETAIL[name]!] : undefined;
+  return typeof value === "string" ? firstLine(value) : null;
+}
+
 // Every scrollback line passes through here. Model and provider text can carry escape codes (OSC 52
 // writes the clipboard), \r and bidi overrides, which the terminal would act on. Prose keeps its line
 // breaks and tabs. A one-line entry has its line breaks escaped too; the screen cuts it after this, by
@@ -23,7 +31,7 @@ export function describe(m: Message): Line[] {
   const lines: Line[] = [];
   for (const p of m.parts) {
     if (p.type === "text") lines.push(m.role === "user" ? { text: `> ${p.text}`, color: "cyan" } : { text: p.text });
-    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
+    else if (p.type === "tool_call") lines.push({ text: `● ${p.name} ${brief(p.name, p.input) ?? JSON.stringify(p.input)}`, color: "yellow", oneLine: true });
     else if (p.type === "tool_result") lines.push({ text: `  ⎿ ${p.isError ? firstLine(p.output) : "ok"}`, color: p.isError ? "red" : "gray", oneLine: true });
     else {
       const _: never = p; // a new kind of part must be given its own line here
```


**Step 4: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 34 passed | 2 skipped (36); Tests 553 passed | 7 skipped (560).

**Step 5: Commit**

```bash
git add src/core/stats.ts src/tui/App.tsx src/tui/StatusLine.tsx src/tui/ToolLine.tsx src/tui/WorkingLine.tsx src/tui/describe.ts tests/clilib.test.ts tests/core/errorlog.test.ts tests/tui/app.test.tsx tests/tui/lines.test.tsx tests/tui/statusline.test.tsx
git commit -m "feat: the working line, compact tool lines, and the tool line under the status line"
```

### Task 14: README, help text and the designs

- **README:** release 3 of 13; the keys and the fuller status line; every `--status` part; the
  session's keys; two known limits (Shift+Enter in Windows Terminal, Ctrl+O printing below). "What
  comes next" lists the main design's 13 releases; it had kept the old 9.
- **The help text** (`src/cli.tsx`): Esc stops a turn, Ctrl-C clears or quits, `?` lists the keys.
- **The main design:** a Decisions row for release 3's as-built choices, and the key probes'
  results under "Still to measure", item 18.
- **The release 3 design:** "As built", where the code differs and why.

**Files:**
- Modify: `README.md`
- Modify: `docs/plans/2026-10-22-tachikoma-design.md`
- Modify: `docs/plans/2026-10-25-tachikoma-release-3-design.md`
- Modify: `src/cli.tsx`

**Step 1: Update the docs and the help text**

**Change `README.md`** (apply with `git apply`, or by hand):

```diff
diff --git a/README.md b/README.md
index 9a4671e..b90037e 100644
--- a/README.md
+++ b/README.md
@@ -5,7 +5,8 @@ providers can lead a session. Later releases add handing work to other models an
 `codex` and `kimi` command-line tools, long-term memory, search of the codebase by meaning, a Docker
 sandbox, and lessons learned from its own error log.
 
-This is release 2 of 13: the core, and signing in with ChatGPT. The command is `tachi`.
+This is release 3 of 13: the core, signing in with ChatGPT, and Claude Code's keys and screen. The
+command is `tachi`.
 
 ## What it does
 
@@ -30,8 +31,14 @@ This is release 2 of 13: the core, and signing in with ChatGPT. The command is `
 - **Your keys and login are kept from the model's tools, against accidents:** shell commands do not
   get the API keys, and the file tools refuse Tachikoma's own data folder, where the ChatGPT login
   is kept. A shell command can still read the login; see [Known limits](#known-limits).
-- **A terminal interface** with a status line showing the lead, how much of the context window is
-  left, tokens, cost (or "ChatGPT plan"), mode and error count. `--status` picks which parts to show.
+- **A terminal interface with Claude Code's keys:** Esc stops a turn, the prompt edits as a shell
+  line does, prompts can run over several lines, Up and Ctrl+R bring back past prompts, and what you
+  type while it works waits its turn. `/` lists the commands, `@` the project's files, Shift+Tab
+  switches the permission mode and `?` lists every key.
+- **A status line** showing the lead, how much of the context window is left (with a bar), tokens,
+  cost (or "ChatGPT plan"), mode, error count, the project folder and git branch, and how long the
+  session has run; a line under it counts the turn's tool calls. `--status` picks which parts to
+  show.
 - **Headless runs:** `-p "<prompt>"` runs one prompt, prints the answer and exits. Add `--json` to
   get every event as one JSON line. Details below.
 - **An error log:** every failure, and every refusal another model answered, is written to
@@ -82,7 +89,7 @@ tachi logout chatgpt                               sign out of ChatGPT
 --mode <mode>     when to ask before acting: ask | project | never (default: ask)
 --effort <level>  Anthropic models only: low | medium | high | xhigh | max
 --fallback <spec> retry a turn the lead refuses on this model, e.g. openai:<model> (off unless set)
---status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors
+--status <list>   status line parts, comma-separated: lead,context,tokens,cost,mode,errors,project,time,tools
 -p, --print <prompt>  run without the interface
 --json            with -p, print every event as one JSON line
 --raw             with -p, print the answer exactly as written, control codes and all
@@ -91,7 +98,8 @@ tachi logout chatgpt                               sign out of ChatGPT
 
 In a session, `/lead <provider:model>` switches the lead model, `/model` picks it from a list,
 `/login chatgpt` and `/logout chatgpt` sign in and out, `/errors` summarises the error log and
-`/exit` quits; commands ignore case. Ctrl-C stops the current turn, or quits when idle.
+`/exit` quits; commands ignore case. Esc or Ctrl-C stops the current turn. When idle, Ctrl-C clears
+the prompt, and pressed twice on an empty prompt it quits. `?` on an empty prompt lists every key.
 
 ## Using your ChatGPT plan
 
@@ -214,21 +222,35 @@ Each is fixed in a later release, unless it says otherwise.
 - **On Windows, PowerShell error messages repeat the whole command**, including the line Tachikoma
   puts first to make the output UTF-8. The ways around it that were tried either lost the exit code or
   turned error messages into XML.
+- **Windows Terminal sends Shift+Enter as Enter,** as tested on 2026-10-25: it does not answer for
+  the kitty keyboard protocol that tells them apart. A backslash then Enter, or Ctrl+J, makes a new
+  line in every terminal (not planned to change).
+- **Ctrl+O prints the last turn's tool calls below the conversation** instead of opening them in
+  place, which needs the full screen (release 5).
 
 ## What comes next
 
 1. Core (done): the agent loop, local file and shell tools, Anthropic and OpenAI-format providers
    with lead switching, the terminal interface with status line, the error log.
-2. Sign in with ChatGPT (this release), so an OpenAI model can lead on your ChatGPT plan instead of
-   an API key; the `/model` picker.
-3. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
+2. Sign in with ChatGPT (done), so an OpenAI model can lead on your ChatGPT plan instead of an API
+   key; the `/model` picker.
+3. Claude Code's keys and screen (this release): stopping, editing, multi-line prompts, history,
+   typing while it works, the `/` menu, `@` paths, Shift+Tab modes, the working line and a fuller
+   status line.
+4. Read-only subagents, with a panel under the prompt, and the to-do list; reading the project's and
+   your own instruction files (AGENTS.md, CLAUDE.md).
+5. Key extras: vim mode, image paste, an external editor, stash, rebinding keys in a file, full
+   screen.
+6. Docker sandbox, in two modes (a live link to your folder, or a copy you review before it is
    applied).
-4. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history.
-5. Skills: the loader, the bundled superpowers skills, and Tachikoma's own.
-6. Search of the codebase by meaning, with EmbeddingGemma 2.
-7. A budget controller, then handing work to the `claude`, `codex` and `kimi` command-line tools.
-8. Loops: on a timer, and until a task is done.
-9. `tachi setup` and `tachi doctor`, and testing a fresh install in CI.
+7. MCP tools and long-term memory (MemPalace); transcripts saved to disk; shortening the history.
+8. Skills: the loader, the bundled superpowers skills, and Tachikoma's own.
+9. Search of the codebase by meaning, with EmbeddingGemma 2.
+10. A budget controller, then handing work to the `claude`, `codex` and `kimi` command-line tools.
+11. Loops: on a timer, and until a task is done.
+12. `tachi setup` and `tachi doctor`, with a first-run import of settings, skills, MCP servers and
+    key bindings from the tools you already use; testing a fresh install in CI.
+13. More providers, and bring-your-own keys.
 
 ## Licence
 
```

**Change `docs/plans/2026-10-22-tachikoma-design.md`** (apply with `git apply`, or by hand):

```diff
diff --git a/docs/plans/2026-10-22-tachikoma-design.md b/docs/plans/2026-10-22-tachikoma-design.md
index 3517ea9..a4ced99 100644
--- a/docs/plans/2026-10-22-tachikoma-design.md
+++ b/docs/plans/2026-10-22-tachikoma-design.md
@@ -38,6 +38,8 @@ learn from experience. The command is `tachi`.
 | Releases 3 to 5 | Claude Code's keys and screen (3), read-only subagents and the to-do list (4), key extras (5); every later release moves down three | User, 2026-10-23 ("We need all sorts of keyboard commands like Claude code", "It should have subagents. It was in the initial brief."; chose each part) |
 | Release 3, choices | History in a private file per project in the data folder; Shift+Tab reaches `never` only when started with `--mode never`; Ctrl+O prints the last turn's tools in full; `@` lists one folder at a time and sends only the path; after Esc the queue goes on, after Ctrl-C it comes back into the prompt | User, 2026-10-25 (chose each option; [release 3 design](2026-10-25-tachikoma-release-3-design.md)) |
 | Release 3, status line | Adds claude-hud's context bar and colours, the project folder and git branch, the session's length and a tool line | User, 2026-10-25 (asked what claude-hud shows; chose all four parts offered) |
+| Release 3, as built | Undo on Ctrl+Z as well as Ctrl+_; the word before the cursor on Alt+Backspace, with Ctrl+Backspace acting as Backspace; the git branch read from `.git/HEAD`, without the `*` for changes; the spinner moving every 80 ms | User, 2026-10-25 (after the key probes in their terminal, and at the build; [release 3 design](2026-10-25-tachikoma-release-3-design.md), "As built") |
+| Instruction files, and importing from other tools | Release 4 reads a project's AGENTS.md or CLAUDE.md, and the user's own, into each session. `tachi setup` (release 12) offers on its first run to import settings, skills, MCP servers and key bindings from Claude Code, Codex and other tools | User, 2026-10-25 ("a first boot import setup to bring over existing Claude and agents Md files and other setting and skills from other programs"; chose both places from options offered) |
 
 ## 1. Overall shape
 
@@ -651,7 +653,8 @@ it.
   - reviewing sandbox work
   - the author's engineering rules: no assumptions without data, simplicity first, surgical
     changes
-- An opt-in `tachi skills import` copies a user's Claude Code skills after checking each licence.
+- A user's skills from Claude Code and other tools are copied by `tachi setup`'s first-run import
+  (release 12), after checking each licence.
 
 ### Status line
 
@@ -699,6 +702,9 @@ tachi setup
 - checks Docker
 - asks for API keys, and also picks up keys already set as environment variables
   (`ANTHROPIC_API_KEY`, etc.)
+- on its first run, offers to import from the tools it finds (Claude Code, Codex and others):
+  settings, skills (each licence checked first), MCP servers and key bindings. Nothing is imported
+  without asking. Which tools, and how each setting maps, are for release 12's design.
 
 Keys are stored in Tachikoma's config folder, readable only by the user. `tachi doctor` checks
 everything again and says what is broken and how to fix it.
@@ -816,6 +822,12 @@ whose results are recorded.
 18. The release 3 checks in the [release 3 design](2026-10-25-tachikoma-release-3-design.md), in the
     user's terminal (Windows Terminal, PowerShell 5.1): whether Shift+Enter and Shift+Tab arrive as
     keys of their own, and that Alt+P, Ctrl+Backspace and a multi-line paste work.
+    **Measured 2026-10-25 (the user's terminal, Node 24.22.1, before the build):** no answer for the
+    kitty protocol, so Shift+Enter arrives as Enter; Ctrl+J and Ctrl+Enter arrive as a line feed.
+    Shift+Tab, Alt+P, Alt+Backspace and Ctrl with each letter used arrive as keys of their own.
+    Ctrl+Backspace and Ctrl+H both send 08, which Ink reports as Backspace. Ctrl+Shift+- sends Esc,
+    so Ctrl+_ cannot be typed there. A paste arrives whole, its line breaks as `\r`. Still to try:
+    the built release itself, from the checklist in the release 3 plan.
 
 ## Release order
 
@@ -831,7 +843,8 @@ Each release works on its own and can be shown.
 3. Claude Code's keys and screen: stopping, editing, multi-line, history, typing while it works,
    the `/` menu, `@` paths, Shift+Tab modes, the working line and a fuller status line
    ([release 3 design](2026-10-25-tachikoma-release-3-design.md))
-4. Read-only subagents (read and search only) with a panel under the prompt, and the to-do list
+4. Read-only subagents (read and search only) with a panel under the prompt, and the to-do list;
+   reading the project's and the user's instruction files (AGENTS.md, CLAUDE.md) into each session
 5. Key extras: vim mode, image paste, external editor, stash, rebinding keys in a file, full screen
 6. Docker sandbox, both modes, including conflict-safe apply for copy-then-review
 7. MCP client, and MemPalace in the uv environment behind the shared supervisor; transcripts on
@@ -841,5 +854,6 @@ Each release works on its own and can be shown.
 10. Budget controller, then CLI workers and delegation, with each CLI's permission mapping and the
     refusal rules. The controller comes first because workers have to be cancellable as a group.
 11. Loops: on a timer, and until done
-12. `tachi setup` / `tachi doctor`, and the fresh-install CI
+12. `tachi setup` / `tachi doctor`, with a first-run import from other tools, and the fresh-install
+    CI
 13. More providers and bring-your-own keys
```

**Change `docs/plans/2026-10-25-tachikoma-release-3-design.md`** (apply with `git apply`, or by hand):

```diff
diff --git a/docs/plans/2026-10-25-tachikoma-release-3-design.md b/docs/plans/2026-10-25-tachikoma-release-3-design.md
index 1d5e3d9..d50d483 100644
--- a/docs/plans/2026-10-25-tachikoma-release-3-design.md
+++ b/docs/plans/2026-10-25-tachikoma-release-3-design.md
@@ -245,3 +245,16 @@ line.
 - Vim mode, image paste, external editor, stash, rebinding keys in a file, full screen: release 5.
 - Claude Code's rewind menu, Alt+Y, the `/` menu in the middle of a prompt, and `@` searching the
   whole project.
+
+**As built (2026-10-25).** Where the code differs from this design, the reason is below. Each was
+the user's choice.
+- **Undo is Ctrl+Z as well as Ctrl+_.** In the user's terminal Ctrl+Shift+- sends Esc and Ctrl+-
+  zooms, so Ctrl+_ cannot be typed there (the key probes, main design item 18).
+- **The word before the cursor goes with Alt+Backspace.** Ctrl+Backspace sends the same byte as
+  Ctrl+H, which Ink reports as Backspace, so it acts as Backspace. Ctrl+W still deletes back to a
+  space.
+- **The git branch is read from `.git/HEAD`, without the `*` for changes.** Running `git status`
+  would be a way round the approval checks: in `project` mode the model can write `.git/config`,
+  whose settings can make git run programs.
+- **The spinner moves every 80 ms,** the rate of the frames it uses (cli-spinners' "dots"); once a
+  second looked too slow. The time still counts in seconds.
```

**Change `src/cli.tsx`** (apply with `git apply`, or by hand):

```diff
diff --git a/src/cli.tsx b/src/cli.tsx
index 1b81285..1265db1 100644
--- a/src/cli.tsx
+++ b/src/cli.tsx
@@ -47,7 +47,8 @@ Options:
 
 In a session: /lead <provider:model> switches the lead model, /model picks it from a list,
 /login chatgpt and /logout chatgpt sign in and out, /errors summarises the error log, /exit quits.
-Ctrl-C stops the current turn, or quits when idle.`;
+Esc or Ctrl-C stops the current turn. When idle, Ctrl-C clears the prompt, and twice on an empty
+prompt quits. ? on an empty prompt lists every key.`;
 
 function fail(message: string): never {
   console.error(message);
```


**Step 2: Run everything**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, then `node node_modules/vitest/vitest.mjs run`

Expected: no type errors; Test Files 34 passed | 2 skipped (36); Tests 553 passed | 7 skipped (560).

**Step 3: Commit**

```bash
git add README.md docs/plans/2026-10-22-tachikoma-design.md docs/plans/2026-10-25-tachikoma-release-3-design.md src/cli.tsx
git commit -m "docs: release 3 in the README, the help text and the designs"
```

**Step 4: Your terminal checklist (you run it, once)**

In Windows Terminal with PowerShell 5.1, build and start a session as usual (`npm run build`, then
`node dist/cli.js --lead <your lead>`), and check each of these:
1. Shift+Tab: the status line says `perm project` and a grey line "mode is now project"; again goes
   back to `ask`.
2. Alt+P opens the model list; Esc closes it, and what was typed is still there.
3. A pasted block of three lines stays in the prompt, unsent, on three lines.
4. Alt+Backspace deletes the word before the cursor; Ctrl+Z undoes it.
5. Ctrl+J, and a backslash then Enter, make a new line. Shift+Enter sends, as the probes found.
6. During a turn, the spinner moves smoothly and the screen does not flicker; Esc stops the turn.
7. Resizing the window while a long prompt is open keeps the cursor on the same character.
8. `/` then Down then Tab fills a command; `@src/` lists the src folder.
9. Ctrl+O after a turn with tool calls prints them in full.

Record the results in the main design's "Still to measure", item 18, and say which failed.
