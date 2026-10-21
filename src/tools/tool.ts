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
