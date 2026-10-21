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
