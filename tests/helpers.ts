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

// A provider whose every request waits until the test answers it, or until it is stopped.
export class Held implements Provider {
  readonly asked: CompletionRequest[] = [];
  #pending: ((t: Turn) => void)[] = [];
  constructor(readonly id = "fake:held") {}
  complete(req: CompletionRequest): Promise<Turn> {
    this.asked.push(structuredClone({ ...req, signal: undefined }));
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
