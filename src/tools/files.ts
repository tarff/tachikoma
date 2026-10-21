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
