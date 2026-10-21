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
