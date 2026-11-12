import { z } from "zod";
import type { PermissionGate } from "../core/permissions.js";
import type { Picture, ToolSpec } from "../core/types.js";
import type { Executor } from "../exec/executor.js";
import type { Workspace } from "../exec/workspace.js";

export interface ToolContext {
  root: string;
  executor: Executor;
  workspace: Workspace; // the project's files, which the file tools read, write and search (release 7 plan, Task 14)
  gate: PermissionGate;
  signal?: AbortSignal;
  // The parts of a result, for the shape hooks are sent (release 8b plan, choice 12): shell, write_file and delegate call it.
  report?: (parts: unknown) => void;
}

export interface Tool {
  spec: ToolSpec;
  // The text the model reads; with pictures, such as an MCP tool's answer, which the session passes on after the results
  // (release 8c plan, choice 10).
  run(input: unknown, ctx: ToolContext): Promise<string | { text: string; pictures: Picture[] }>;
  parallel?: boolean; // a reply's calls of it start together (delegate); other calls run one after another
}

// A tool whose answer is text alone, as each of Tachikoma's own is.
export interface TextTool extends Tool {
  run(input: unknown, ctx: ToolContext): Promise<string>;
}

// An input the tool's schema refused, after which no PostToolUseFailure hook runs (Claude Code's hooks reference;
// release 8b plan, Task 7).
export class InvalidInput extends Error {}

// A tool whose input is checked against its schema before it runs. Model output is untrusted.
// An object schema, because both provider APIs require one for tool input.
export function defineTool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>,
): TextTool {
  const { $schema: _, ...inputSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    spec: { name, description, inputSchema },
    async run(input, ctx) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new InvalidInput(`Invalid input for ${name}: ${z.prettifyError(parsed.error)}`);
      return run(parsed.data, ctx);
    },
  };
}
