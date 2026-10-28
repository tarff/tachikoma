import { type BigIntStats, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "../core/datadir.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
import { SETTINGS, settingsDir } from "../settings.js";
import { defineTool } from "./tool.js";

// The keys file, beside the settings file in the settings folder.
const KEYBINDINGS = "keybindings.json";

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

// Whether `rel`, a path relative to some folder, leads out of it. On Windows a path on another drive
// comes back absolute.
export const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

const same = (a: BigIntStats | undefined, b: BigIntStats) => a !== undefined && a.dev === b.dev && a.ino === b.ino;

// Whether `real` is the data folder or in it. The path is compared first, which also covers a data
// folder not made yet. Then each folder on the way up is compared by what it is (its volume and file
// number), since Windows reaches one folder by its short name, by \\?\ and by \\localhost\C$, and
// macOS ignores case. A hard link is another name for a file in an ordinary folder, so a file with
// more than one name is compared with each file directly in the data folder.
function inData(data: string, real: string): boolean {
  if (!leaves(path.relative(data, real))) return true;
  const id = statSync(data, { bigint: true, throwIfNoEntry: false });
  if (!id) return false;
  for (let p = real; ; p = path.dirname(p)) {
    if (same(statSync(p, { bigint: true, throwIfNoEntry: false }), id)) return true;
    if (path.dirname(p) === p) break;
  }
  const file = statSync(real, { bigint: true, throwIfNoEntry: false });
  if (!file || !file.isFile() || file.nlink < 2n) return false;
  return readdirSync(data).some((name) => same(statSync(path.join(data, name), { bigint: true, throwIfNoEntry: false }), file));
}

// Whether `name`, in the settings folder, is the settings file, the keys file, or a companion of either:
// the lock and temporary files saving the settings makes beside it (settings.json.lock,
// settings.json.<pid>.<hex>.tmp), or what an editor saving one leaves there. Compared as Windows reads a
// name, so another spelling cannot make one: ignoring case (as macOS does), the dots and spaces it drops
// from the end, and a ":stream" after it.
export function settingsName(name: string): boolean {
  const n = name.replace(/:.*/s, "").replace(/[. ]+$/, "").toLowerCase();
  return [SETTINGS, KEYBINDINGS].some((file) => n === file || n.startsWith(`${file}.`));
}

// Whether `real` is one of the settings folder's protected files, or a path inside one (which would
// make it a folder). As for the data folder: the folder by path, which covers one not made yet, or by
// what it is, and a file with more than one name compared with each protected file directly.
function inSettings(folder: string, real: string): boolean {
  const id = statSync(folder, { bigint: true, throwIfNoEntry: false });
  for (let p = real; path.dirname(p) !== p; p = path.dirname(p)) {
    if (!settingsName(path.basename(p))) continue;
    const parent = path.dirname(p);
    if (path.relative(folder, parent) === "" || (id && same(statSync(parent, { bigint: true, throwIfNoEntry: false }), id))) return true;
  }
  const file = statSync(real, { bigint: true, throwIfNoEntry: false });
  if (!id || !file || !file.isFile() || file.nlink < 2n) return false;
  return readdirSync(folder).some((name) => settingsName(name) && same(statSync(path.join(folder, name), { bigint: true, throwIfNoEntry: false }), file));
}

// On Linux, /proc/<process>/environ is a program's starting environment, API keys included, and
// /proc/self leads to Tachikoma's own.
export const programEnvironment = (real: string) => /^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/.test(real);

// `shown` is what the approval prompt names: the path, plus where it really leads when a link takes
// it somewhere else.
export function resolveIn(root: string, p: string): { abs: string; outside: boolean; shown: string } {
  const abs = path.resolve(root, p);
  const base = realTarget(root);
  const real = realTarget(abs);
  if (base === null || real === null) return { abs, outside: true, shown: `${abs} (through a link that leads nowhere)` };
  // The saved login lives there. Refused in every mode, `never` included, and after following links,
  // so a link cannot get round it.
  const data = realTarget(path.resolve(dataDir()));
  if (data === null || inData(data, real)) throw new Error(`${abs} is in Tachikoma's data folder, which the file tools never touch`);
  // The settings and keys files, the same way: when the project is the home folder they are inside it,
  // where `project` mode would let the model rewrite them unasked.
  const settings = realTarget(settingsDir());
  if (settings === null || inSettings(settings, real)) {
    throw new Error(`${abs} is one of Tachikoma's settings files, which the file tools never touch; edit it with /settings or /keybindings`);
  }
  if (programEnvironment(real)) throw new Error(`${abs} is a program's environment, which can hold API keys, so the file tools never read it`);
  const rel = path.relative(base, real);
  return { abs, outside: leaves(rel), shown: rel === path.relative(root, abs) ? abs : `${abs} (really ${real})` };
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
    const row = (n: number) => `${String(n).padStart(6)}\t${lines[n - 1]}`;
    if (offset === 1 && limit >= lines.length) {
      const whole = lines.map((_, i) => row(i + 1)).join("\n");
      if (whole.length <= MAX_TOOL_OUTPUT) return whole; // the whole file needs no note
    }
    const note = (last: number) => `(showing lines ${offset}-${last} of ${lines.length}; use offset and limit to read the rest)`;
    // Stops before the session's cut at MAX_TOOL_OUTPUT, leaving room for the longest note, so the note
    // names the last line really shown. One line too long for the room on its own is still shown, and
    // the session cuts it.
    const room = MAX_TOOL_OUTPUT - note(lines.length).length - 1;
    const rows: string[] = [];
    let size = 0;
    for (let n = offset; n < offset + limit && n <= lines.length; n++) {
      if (rows.length && size + row(n).length + 1 > room) break;
      rows.push(row(n));
      size += row(n).length + 1;
    }
    return `${note(offset + rows.length - 1)}\n${rows.join("\n")}`; // first, not last: the session cuts from the end
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
    // Inside the project a read needs no approval, so an edit that cannot work fails before the user is
    // asked. It is checked again after: the file may change while the question waits.
    if (!outside) edited(await ctx.executor.readFile(abs), p, old_text, new_text);
    await ctx.gate.require({ kind: "write", outside, summary: `edit ${shown}`, detail });
    await ctx.executor.writeFile(abs, edited(await ctx.executor.readFile(abs), p, old_text, new_text));
    return `Edited ${p}`;
  },
);

// The file with the edit made, or why it cannot be. read_file hides \r, so when the text as sent is not
// found in a file with Windows line endings, its \n is tried as \r\n.
function edited(text: string, p: string, old_text: string, new_text: string): string {
  // Bytes that are not UTF-8 read back as U+FFFD, and writing the text back would destroy them.
  if (text.includes("�")) throw new Error(`${p} is not UTF-8 text, so edit_file would damage it`);
  // The text as sent first: a file can mix both endings, and its \n part must stay editable.
  const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");
  const times = (s: string) => text.split(s).length - 1;
  const exact = times(old_text) > 0 || !text.includes("\r\n");
  const [from, to] = exact ? [old_text, new_text] : [crlf(old_text), crlf(new_text)];
  const count = times(from);
  if (count === 0) throw new Error(`old_text was not found in ${p}${text.includes("\r\n") ? " (the file uses CRLF line endings in places)" : ""}`);
  if (count > 1) throw new Error(`old_text appears ${count} times in ${p}; include more surrounding text so it is unique`);
  return text.replace(from, () => to);
}
