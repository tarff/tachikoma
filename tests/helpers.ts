import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
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

// A provider whose every request waits until the test answers it, or until it is stopped.
export class Held implements Provider {
  readonly asked: CompletionRequest[] = [];
  #pending: ((t: Turn) => void)[] = [];
  constructor(readonly id = "fake:held") {}
  complete(req: CompletionRequest): Promise<Turn> {
    this.asked.push(structuredClone({ ...req, signal: undefined, shrunk: undefined, leftOut: undefined })); // neither can be cloned
    return new Promise((resolve, reject) => {
      this.#pending.push(resolve);
      req.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }
  // Answers the oldest request still waiting.
  answer(turn: Turn | string) {
    this.#pending.shift()!(typeof turn === "string" ? reply(turn) : turn);
  }
}

export function collectErrors(bus: Bus): ErrorEvent[] {
  const errors: ErrorEvent[] = [];
  bus.on("error", (e) => errors.push(e));
  return errors;
}

export async function tempContext(mode: Mode = "never", answers: boolean[] = []): Promise<ToolContext & { asked: string[]; details: (string | undefined)[] }> {
  const root = await mkdtemp(path.join(tmpdir(), "tachi-"));
  const asked: string[] = [];
  const details: (string | undefined)[] = [];
  const gate = new PermissionGate(mode, async (summary, detail) => {
    asked.push(summary);
    details.push(detail);
    return answers.shift() ?? false;
  });
  return { root, executor: new LocalExecutor(), gate, asked, details };
}

export const texts = (m: Message) => m.parts.flatMap((p: Part) => (p.type === "text" ? [p.text] : []));
export { Bus };

// The short (8.3) name Windows gave `name` in `folder`, such as SETTIN~1.JSO, as `dir /x` lists it.
// Undefined on other systems, and on a volume that makes none.
export function shortName(folder: string, name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const listing = execFileSync("cmd", ["/c", "dir", "/x", "/a", folder], { encoding: "utf8" });
  return new RegExp(`(\\S+~\\d+\\S*) +${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im").exec(listing)?.[1];
}

// A stand-in editor (release 6 plan, Task 12): a small Node script, so no test ever opens a real editor. It is
// written in a fresh temporary folder whose name has a space, as the path to this repo has, so the shell's quoting is
// tried, and the folder is removed when the test finishes. `command(mode)` is the editor's command; the file comes
// after it. Each run records the file it was given and that file's text in given.json, then, by mode: `keep` writes
// next.txt into the file when there is one; `wait` does the same, marks `started`, and waits until `go` is written or
// its folder is gone; `fail` exits 1; `line` writes the first line it reads from its own stdin into the file.
export function standInEditor() {
  const dir = mkdtempSync(path.join(tmpdir(), "tachi editor "));
  const at = (name: string) => path.join(dir, name);
  writeFileSync(at("editor.cjs"), STAND_IN);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    command: (mode: "keep" | "wait" | "fail" | "line") => `"${process.execPath}" "${at("editor.cjs")}" ${mode}`,
    next: (text: string) => writeFileSync(at("next.txt"), text),
    given: (): { file: string; text: string } | null => (existsSync(at("given.json")) ? JSON.parse(readFileSync(at("given.json"), "utf8")) : null),
    started: () => existsSync(at("started")),
    go: () => writeFileSync(at("go"), ""),
  };
}
const STAND_IN = String.raw`const fs = require("node:fs");
const path = require("node:path");
const [mode, file] = process.argv.slice(2);
const at = (name) => path.join(__dirname, name);
fs.writeFileSync(at("given.json"), JSON.stringify({ file, text: fs.readFileSync(file, "utf8") }));
if (mode === "fail") process.exit(1);
if (mode === "line") {
  let read = "";
  process.stdin.setEncoding("utf8").on("data", (d) => {
    read += d;
    if (!read.includes("\n")) return;
    fs.writeFileSync(file, read.slice(0, read.indexOf("\n")));
    process.exit(0);
  });
} else {
  if (fs.existsSync(at("next.txt"))) fs.writeFileSync(file, fs.readFileSync(at("next.txt"), "utf8"));
  if (mode === "wait") {
    fs.writeFileSync(at("started"), "");
    const poll = () => !fs.existsSync(at("go")) && fs.existsSync(__dirname) && setTimeout(poll, 20);
    poll();
  }
}
`;
