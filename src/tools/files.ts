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

// Read the way Claude Code's own Read tool does (its tool description, 2026-10-22): up to 2,000 lines
// unless `limit` says otherwise, from line `offset` (counted from 1), each after its number in
// `cat -n` style.
const READ_LINES = 2000;

export const readFileTool = defineTool(
  "read_file",
  `Read a text file. Paths are relative to the project root. Shows up to ${READ_LINES} lines, each after its line number and a tab; offset (the first line, from 1) and limit read other parts. The numbers are not part of the file.`,
  z.object({ path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() }),
  async ({ path: p, offset = 1, limit = READ_LINES }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "read", outside, summary: `read ${shown}` });
    const text = await ctx.executor.readFile(abs);
    if (!text) return `(${p} is empty)`;
    const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
    if (offset > lines.length) return `(${p} has ${lines.length} lines)`;
    const part = lines.slice(offset - 1, offset - 1 + limit);
    const last = offset + part.length - 1;
    const numbered = part.map((l, i) => `${String(offset + i).padStart(6)}\t${l}`).join("\n");
    // First, not last: the session cuts long tool output from the end.
    if (offset === 1 && last === lines.length) return numbered;
    return `(showing lines ${offset}-${last} of ${lines.length}; use offset and limit to read the rest)\n${numbered}`;
  },
);

export const writeFileTool = defineTool(
  "write_file",
  "Create or overwrite a text file. Paths are relative to the project root.",
  z.object({ path: z.string(), content: z.string() }),
  async ({ path: p, content }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    await ctx.gate.require({ kind: "write", outside, summary: `write ${shown}`, detail: content });
    await ctx.executor.writeFile(abs, content);
    return `Wrote ${content.length} characters to ${p}`;
  },
);

export const editFileTool = defineTool(
  "edit_file",
  "Replace one exact, unique piece of text in a file. Read the file first; old_text leaves out the line numbers read_file shows.",
  z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
  async ({ path: p, old_text, new_text }, ctx) => {
    const { abs, outside, shown } = resolveIn(ctx.root, p);
    const marked = (sign: string, s: string) => s.split("\n").map((l) => `${sign} ${l}`);
    const detail = [...marked("-", old_text), ...(new_text ? marked("+", new_text) : [])].join("\n");
    await ctx.gate.require({ kind: "write", outside, summary: `edit ${shown}`, detail });
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
