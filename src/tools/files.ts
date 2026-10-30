import { type BigIntStats, existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir, KEYBINDINGS, SETTINGS, settingsDir } from "../core/datadir.js";
import { MAX_TOOL_OUTPUT } from "../exec/executor.js";
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
  return path.join(realPlace(existing), ...rest);
}

// Where an existing path really is, as Windows says (realpathSync.native): Node's lstat does not see a junction to a
// drive named by its ID (\\?\Volume{...}\) as a link and follows it, so the JavaScript realpath, which goes part by
// part, gave such a junction's target as the junction's own place. The JavaScript one when Windows' throws, as it can
// on some virtual drives (review fixes plan, fix 12).
function realPlace(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return realpathSync(p);
  }
}

// Whether `rel`, a path relative to some folder, leads out of it. On Windows a path on another drive
// comes back absolute.
export const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

const same = (a: BigIntStats | undefined, b: BigIntStats) => a !== undefined && a.dev === b.dev && a.ino === b.ino;

// What a folder on the way up is, or nothing. Windows cannot stat a drive's root spelled \\?\C:\ (EISDIR, though
// C:\ works), and a drive's root is never the data or settings folder.
function folderOf(p: string): BigIntStats | undefined {
  try {
    return statSync(p, { bigint: true, throwIfNoEntry: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR" && path.dirname(p) === p) return undefined;
    throw err;
  }
}

// Whether `real` is the data folder or in it. The path is compared first, which also covers a data
// folder not made yet. Then each folder on the way up is compared by what it is (its volume and file
// number), since Windows reaches one folder by its short name, by \\?\ and by \\localhost\C$, and
// macOS ignores case. A hard link is another name for a file in an ordinary folder, so a file with
// more than one name is compared with each file directly in the data folder. `platform` is the system's, which a test
// gives as another's, with that system's path rules (samePath).
export function inData(data: string, real: string, platform: NodeJS.Platform = process.platform): boolean {
  if (withinPath(data, real, platform)) return true;
  const id = statSync(data, { bigint: true, throwIfNoEntry: false });
  if (!id) return false;
  for (let p = real; ; p = path.dirname(p)) {
    if (same(folderOf(p), id)) return true;
    if (path.dirname(p) === p) break;
  }
  const file = statSync(real, { bigint: true, throwIfNoEntry: false });
  if (!file || !file.isFile() || file.nlink < 2n) return false;
  return readdirSync(data).some((name) => same(statSync(path.join(data, name), { bigint: true, throwIfNoEntry: false }), file));
}

// Whether `name`, in the settings folder, is the settings file, the keys file, or a companion of either
// whose name starts with the file's and a dot, such as what an editor saving one leaves there (Tachikoma
// itself saves neither, release 6 plan, choice 26). Compared as Windows reads a
// name, so another spelling cannot make one: ignoring case (as macOS does), the dots and spaces it drops
// from the end, and a ":stream" after it.
export function settingsName(name: string): boolean {
  const n = name.replace(/:.*/s, "").replace(/[. ]+$/, "").toLowerCase();
  return [SETTINGS, KEYBINDINGS].some((file) => n === file || n.startsWith(`${file}.`));
}

// Whether two paths are one folder's by their spelling on a system whose disks ignore case, Windows and
// macOS: by path alone, before ~/.tachikoma is made, path.relative ignores case only on Windows, so on
// macOS .TACHIKOMA/settings.json passed (release 6 plan, choice 30, the security review's finding 5).
export const sameIgnoringCase = (a: string, b: string, platform: NodeJS.Platform = process.platform) =>
  (platform === "win32" || platform === "darwin") && a.toLowerCase() === b.toLowerCase();

// Whether two paths are one folder's by path alone: by the system's own rules, Windows' ignoring case, and by the case
// rule above. The rules are the platform's, so a test of macOS's on Windows reaches the case rule (found at the
// combined review).
const rules = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);
const samePath = (a: string, b: string, platform: NodeJS.Platform) => rules(platform).relative(a, b) === "" || sameIgnoringCase(a, b, platform);

// Whether `p` is `folder`, or inside it, by path alone: for the data folder, which may not be made yet (choice 30).
function withinPath(folder: string, p: string, platform: NodeJS.Platform): boolean {
  const { dirname } = rules(platform);
  for (let q = p; ; q = dirname(q)) {
    if (samePath(folder, q, platform)) return true;
    if (dirname(q) === q) return false;
  }
}

// Whether `real` is one of the settings folder's protected files, or a path inside one (which would
// make it a folder). As for the data folder: the folder by path, which covers one not made yet, or by
// what it is. An existing file is also compared by what it is with each protected file: one in the
// folder, since Windows gives each a short name (SETTIN~1.JSO) that the real path keeps, and one
// anywhere with more than one name, since a hard link is another name for it. `platform` as for inData.
export function inSettings(folder: string, real: string, platform: NodeJS.Platform = process.platform): boolean {
  const id = statSync(folder, { bigint: true, throwIfNoEntry: false });
  const isFolder = (p: string) => samePath(folder, p, platform) || (id !== undefined && same(folderOf(p), id));
  for (let p = real; path.dirname(p) !== p; p = path.dirname(p)) {
    if (settingsName(path.basename(p)) && isFolder(path.dirname(p))) return true;
  }
  const file = statSync(real, { bigint: true, throwIfNoEntry: false });
  if (!id || !file || !file.isFile() || (file.nlink < 2n && !isFolder(path.dirname(real)))) return false;
  return readdirSync(folder).some((name) => settingsName(name) && same(statSync(path.join(folder, name), { bigint: true, throwIfNoEntry: false }), file));
}

// On Linux, /proc/<process>/environ is a program's starting environment, API keys included, and
// /proc/self leads to Tachikoma's own.
export const programEnvironment = (real: string) => /^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/.test(real);

// A network or device path (review fixes plan, fix 2): on Windows, one starting with \\ or // once resolved, a share,
// \\?\UNC\, a named pipe or a device, but not \\?\ or \\.\ before a drive letter, Windows' long-path spelling of an
// ordinary local file (the user's choice at the build, "Count as local"). Touching one can make Windows sign in to a
// server, so the file tools refuse one outside the project before anything opens it.
const networkPath = (p: string) => process.platform === "win32" && /^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/][a-z]:\\/i.test(p);
// The share a path is on, \\server\share in lower case, whether written \\server\share or \\?\UNC\server\share; none
// for a device path (\\?\ or \\.\ before anything else, \\.\UNC\ included) or a local one (review fixes plan, fix 13).
function shareOf(p: string): string | undefined {
  const m = /^\\\\(?:\?\\unc\\)?([^\\]+)\\([^\\]+)/i.exec(p);
  return m && m[1] !== "?" && m[1] !== "." ? `${m[1]}\\${m[2]}`.toLowerCase() : undefined;
}
const NEVER_OPENED = "which the file tools never open; a shell command can reach it, after asking";
const leadsThrough = (start: string, link: string, target: string) =>
  `${start} leads through ${link} to a network or device path outside the project (${target}), ${NEVER_OPENED}`;

// A link whose stored target begins with one \ or / (not two, and not a drive letter): on Windows, the internal forms
// such as \??\GLOBALROOT\Device\Mup\server\share and \Device\Mup\server\share, which path.resolve would make a local
// path (C:\Device\...) though the link leads to the network, and the rare link written as \folder (review fixes plan,
// fix 9, the user's choice, "Any single-slash start"). Where it leads cannot be told without following it.
type Unchecked = { link: string; target: string };

// Where a walk starts: the path's drive, or for a share its root, \\server\share\ or \\?\UNC\server\share\; path.parse
// gives \\?\UNC\ alone for the second, which would make the server on its own the walk's first part (review fixes plan,
// fix 13, found at the spec review).
const walkRoot = (p: string) => /^\\\\\?\\unc\\[^\\]+\\[^\\]+/i.exec(p)?.[0].concat("\\") ?? path.parse(p).root;

// Walks `start` one part at a time from its drive, or from `from` with the parts in `after`, as realpath would, but
// looks before it follows (the plan, fix 2):
// lstat does not follow the part it is given, and the parts above it are already plain folders or links whose targets
// were checked; a link's target is read without opening it. A target that is a network or device path for which
// `allowed` is false is refused; any other takes the place of the parts walked so far. The walk ends at the first part
// that does not exist. A link can rightly be passed twice, so a loop is ended by counting: a path past 63 links is
// refused, the most reparse points Windows allows on one path ("Reparse Points", learn.microsoft.com; review fixes
// plan, fix 7, the user's choice; 64 junctions gave ELOOP when probed, 2026-10-30). Returns where it ended, the first
// link whose stored target is Unchecked, which is not followed (fix 9), or null past 63 links, so the root's walk
// can say it in its own words (fix 14).
function linkHops(start: string, allowed: (target: string) => boolean, from = walkRoot(start), after = start.slice(from.length)): string | Unchecked | null {
  let done = from;
  const rest = after.split(path.sep).filter(Boolean);
  let links = 0;
  while (rest.length) {
    const next = path.join(done, rest[0]!);
    const kind = lstatSync(next, { throwIfNoEntry: false });
    if (!kind) break;
    rest.shift();
    if (!kind.isSymbolicLink()) {
      done = next;
      continue;
    }
    if (++links > 63) return null;
    const stored = readlinkSync(next);
    if (/^[\\/](?![\\/])/.test(stored)) return { link: next, target: stored };
    const target = path.resolve(path.dirname(next), stored);
    // Named without the backslash Node adds at the end of a share's root (review fixes plan, fix 11).
    if (networkPath(target) && !allowed(target)) throw new Error(leadsThrough(start, next, target.replace(/\\$/, "")));
    done = walkRoot(target);
    rest.unshift(...target.slice(done.length).split(path.sep).filter(Boolean));
  }
  return path.join(done, ...rest);
}

// Each project root's real place, from its walk at the first resolveIn for it. A network target there is allowed: the
// user started Tachikoma in that folder. One that met an Unchecked link is kept as that link: where the project really
// is cannot be told, so every path in it is refused (fix 9, the user's choice at the build, "Refuse, own message"), and
// so is every path for one past 63 links (null). rulesIn (search.ts) passes the folder of a .gitignore with more than
// one name as the root, so such folders get their own entry. The project's own folder, as well as the folders above
// it, is taken once a session: one replaced by a link during the session (only a shell command, which asks, can do
// that) is not seen (fix 14).
const rootPlaces = new Map<string, string | Unchecked | null>();

// `shown` is what the approval prompt names: the path, plus where it really leads when a link, or Windows' own
// spelling of the real place (a path typed as \\?\C:\... or with a short name), differs from what was typed (review
// fixes plan, fix 12, the user's choice, "Show the real place").
export function resolveIn(root: string, p: string, { trusted = false }: { trusted?: boolean } = {}): { abs: string; outside: boolean; shown: string } {
  const abs = path.resolve(root, p);
  // `trusted` skips the root's walk, the text check and the link check, with its 63-link count, so network and device
  // paths go through: for the user's own instruction files and what they import, read before the check was made
  // (review fixes plan, fix 10, the user's choice, "Allow your own files"; fix 14). The checks below still apply. Only
  // on Windows, as networkPath is false elsewhere: the walks double the cost of each path check, and the @ menu checks
  // every entry of a folder on each keystroke (fix 11).
  if (!trusted && process.platform === "win32") {
    if (!rootPlaces.has(root)) rootPlaces.set(root, linkHops(path.resolve(root), () => true));
    const place = rootPlaces.get(root)!;
    const fromRoot = path.relative(root, abs);
    if (typeof place !== "string") {
      // "In a project" only of a path in it by its text (fix 14).
      const why =
        place === null
          ? `passes through more than 63 links, ${NEVER_OPENED}`
          : `leads through ${place.link} to ${place.target}, a link the file tools cannot check, so they never open it; a shell command can reach it, after asking`;
      throw new Error(leaves(fromRoot) ? `${abs} cannot be checked, as the project's own folder ${why}` : `${abs} is in a project whose own folder ${why}`);
    }
    // Inside the root by its text, or inside the root's real place, or on the share that place is on: Windows has
    // already signed in there for the project (fix 13, the user's choice, "Same share is fine"). One outside the
    // project still asks, as any path outside it does.
    const share = shareOf(place);
    const inRoot = (q: string) => !leaves(path.relative(root, q)) || !leaves(path.relative(place, q)) || (share !== undefined && shareOf(q) === share);
    // By its text, so \\localhost\C$\<project> is refused though it is the project (fix 11, the words).
    if (networkPath(abs) && !inRoot(abs)) {
      throw new Error(`${abs} is a network or device path not written as a path in the project, so the file tools do not open it; a shell command can reach it, after asking`);
    }
    // A path in the root by its text is walked from the root's real place, as the root's own parts were walked
    // already, so a link on the way to a root on a share is not checked again as if it led out (review fixes plan,
    // fix 8). Any other path is walked from its drive.
    // From the root's real place (`from`), with the path from the root to abs (`after`).
    const walked = leaves(fromRoot) ? linkHops(abs, inRoot) : linkHops(abs, inRoot, place, fromRoot);
    if (walked === null) throw new Error(`${abs} passes through more than 63 links, ${NEVER_OPENED}`);
    if (typeof walked !== "string") throw new Error(leadsThrough(abs, walked.link, walked.target));
  }
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
