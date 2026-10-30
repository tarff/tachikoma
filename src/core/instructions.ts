import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { leaves, resolveIn } from "../tools/files.js";
import { errorText } from "./types.js";

// Put before the files in the system prompt (release 4 design, "Instruction files").
export const NOTE =
  "The user's and the project's instruction files (CLAUDE.md, AGENTS.md) follow, broadest first, each with its path. Where they disagree, the later, more specific file wins.";

export interface Where {
  root: string; // the project folder
  home?: string; // the user's folder; os.homedir() unless a test gives its own
  codexHome?: string; // CODEX_HOME, where the user's AGENTS.md is when set
  top?: string; // where the walk down to the project starts: the top of the drive unless a test gives its own
}

// A file outside the project the instruction files lead to, and how: "imported by <file>" or "found as <file>".
export interface Reached {
  path: string;
  how: string;
}

export interface Instructions {
  text: string; // for the system prompt; empty with no files
  read: { path: string; size: number }[]; // in the order they appear, imports included
  left: { path: string; why: string }[]; // files left out, and why
}

// Each folder's files, in Claude Code's order, then Codex's (Claude Code's memory.md and Codex's
// agents-md, read 2026-10-25); both kinds are read where both exist.
const NAMES = ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md", "AGENTS.md"];
// Imports are followed "a maximum depth of four hops", as in Claude Code (memory.md).
const HOPS = 4;

interface Loaded {
  path: string;
  size: number;
  pieces: (string | { token: string; file: Loaded })[]; // the text, with each import in its place
  ask?: Reached; // set when it needs the user's approval
  shut?: boolean; // left out: not allowed, or once allowed could not be read
}

// A file reached: its text, none until it is read, whether it is trusted, and the hops its imports
// were expanded from.
interface Seen {
  f: Loaded;
  real: string;
  text?: string;
  trusted: boolean;
  hops: number;
}

// The folders from `top` down to `root`, both included.
function folders(top: string, root: string): string[] {
  const rel = path.relative(top, root);
  if (leaves(rel)) return [root];
  const out = [top];
  for (const part of rel.split(path.sep).filter(Boolean)) out.push(path.join(out.at(-1)!, part));
  return out;
}

// Reads the user's and the project's instruction files once, at the start of a session. The user's
// own two files, and what they import, are trusted. Any other file that leads out of the project, an
// import or a found file a link takes to another folder, is opened only once `approve` allows it: those
// reached are asked about together, and then any more that the allowed ones import, so none is opened
// before the user sees its name. Tachikoma's data folder and a program's environment are never read,
// whatever `approve` says: resolveIn refuses them after following links.
export async function readInstructions(where: Where, approve: (reached: Reached[]) => Promise<boolean>): Promise<Instructions> {
  const home = where.home ?? os.homedir();
  const left: Instructions["left"] = [];
  // By real path, so a file reached twice, by a link, an import or the walk, is read once: its text,
  // and the hops its imports were expanded from, so one reached again with more hops left is expanded
  // again from there. Null for one that is not read.
  const loaded = new Map<string, Seen | null>();
  // The files whose imports are being expanded, so an import loop back to one stays as text.
  const expanding = new Set<string>();
  const expand = async (e: Seen) => {
    expanding.add(e.real);
    e.f.pieces = e.hops < HOPS ? await imports(e.text!, e.f.path, e.trusted, e.hops + 1) : [e.text!];
    expanding.delete(e.real);
  };
  const waiting: Seen[] = []; // files to ask about, in the order reached

  // Reads a file and expands its imports. False for one that cannot go in, with the reason in `left`
  // where there is one; an empty file has none.
  async function open(e: Seen): Promise<boolean> {
    let buf: Buffer;
    try {
      buf = await readFile(e.real);
    } catch (err) {
      left.push({ path: e.f.path, why: (err as NodeJS.ErrnoException).code ?? errorText(err) });
      return false;
    }
    if (buf.includes(0)) {
      left.push({ path: e.f.path, why: "not text" });
      return false;
    }
    const text = buf.toString("utf8");
    if (!text.trim()) return false;
    e.text = text;
    e.f.size = buf.length;
    await expand(e);
    return true;
  }

  async function load(abs: string, opts: { trusted: boolean; hops: number; foundIn?: string; by?: string }): Promise<Loaded | null> {
    let outside: boolean;
    try {
      // Your own files, and what they import, may be on a share (review fixes plan, fix 10).
      ({ outside } = resolveIn(where.root, abs, opts.trusted));
    } catch (err) {
      left.push({ path: abs, why: errorText(err) });
      return null;
    }
    const real = await realpath(abs).catch(() => null);
    if (real === null) return null; // nothing there
    if (expanding.has(real)) return null;
    const seen = loaded.get(real);
    if (seen === null) return null;
    if (seen) {
      if (opts.hops < seen.hops) {
        seen.hops = opts.hops;
        if (seen.text !== undefined) await expand(seen);
      }
      return seen.f;
    }
    loaded.set(real, null);
    // Only a file is read: a folder cannot be, a device such as /dev/zero never ends, and a named pipe
    // waits for a writer.
    if (!(await stat(real).catch(() => null))?.isFile()) {
      left.push({ path: abs, why: "not a file" });
      return null;
    }
    let ask: Reached | undefined;
    if (opts.trusted) ask = undefined;
    else if (opts.foundIn !== undefined) ask = leaves(path.relative(await realpath(opts.foundIn), real)) ? { path: real, how: `found as ${abs}` } : undefined;
    else if (outside) ask = { path: abs, how: `imported by ${opts.by}` };
    const e: Seen = { f: { path: abs, size: 0, pieces: [], ...(ask ? { ask } : {}) }, real, trusted: opts.trusted, hops: opts.hops };
    loaded.set(real, e);
    if (ask) {
      waiting.push(e); // opened once allowed
      return e.f;
    }
    if (await open(e)) return e.f;
    loaded.set(real, null);
    return null;
  }

  // `@path` imports, expanded where they stand: relative to the file they are in, or absolute, or from
  // `~`. Not inside code blocks or code spans. One that leads nowhere stays as text.
  async function imports(text: string, file: string, trusted: boolean, hops: number): Promise<Loaded["pieces"]> {
    const pieces: Loaded["pieces"] = [];
    let plain = "";
    let fenced = false;
    for (const line of text.split(/(?<=\n)/)) {
      const fence = /^\s*(```|~~~)/.test(line);
      if (fence) fenced = !fenced;
      if (fence || fenced) {
        plain += line;
        continue;
      }
      for (const [i, part] of line.split(/(`[^`]*`)/).entries()) {
        if (i % 2) {
          plain += part; // a code span
          continue;
        }
        let last = 0;
        for (const m of part.matchAll(/(?<=^|\s)@(\S+)/g)) {
          const name = m[1]!;
          const target = name === "~" || name.startsWith("~/") || name.startsWith("~\\") ? path.join(home, name.slice(1)) : path.resolve(path.dirname(file), name);
          const found = await load(target, { trusted, hops, by: file });
          if (!found) continue;
          pieces.push(plain + part.slice(last, m.index), { token: m[0], file: found });
          plain = "";
          last = m.index + m[0].length;
        }
        plain += part.slice(last);
      }
    }
    pieces.push(plain);
    return pieces;
  }

  const found: Loaded[] = [];
  const add = async (abs: string, opts: Parameters<typeof load>[1]) => {
    const f = await load(abs, opts);
    if (f) found.push(f);
  };
  await add(path.join(home, ".claude", "CLAUDE.md"), { trusted: true, hops: 0 });
  await add(path.join(where.codexHome ?? path.join(home, ".codex"), "AGENTS.md"), { trusted: true, hops: 0 });
  for (const folder of folders(where.top ?? path.parse(where.root).root, where.root)) {
    for (const name of NAMES) await add(path.join(folder, name), { trusted: false, hops: 0, foundIn: folder });
  }

  // Each round asks about the files reached since the last, each reached twice asked about once.
  for (let from = 0; from < waiting.length; ) {
    const round = waiting.slice(from);
    from = waiting.length;
    const allowed = await approve(round.map((e) => e.f.ask!));
    for (const e of round) {
      if (!allowed) left.push({ path: e.f.ask!.path, why: "not allowed" });
      if (!allowed || !(await open(e))) e.f.shut = true;
    }
  }
  const out = (f: Loaded) => f.shut === true;

  // Each file goes in once, at its first place that is allowed: a project file that a declined file
  // imports still goes in where the walk found it.
  const read: Instructions["read"] = [];
  const done = new Set<Loaded>();
  const compose = (f: Loaded): string => {
    done.add(f);
    read.push({ path: f.path, size: f.size });
    const body = f.pieces.map((p) => (typeof p === "string" ? p : out(p.file) || done.has(p.file) ? p.token : compose(p.file))).join("");
    return `<file path="${f.path}">\n${body.trimEnd()}\n</file>`;
  };
  const files = found.flatMap((f) => (out(f) || done.has(f) ? [] : [compose(f)]));
  return { text: files.length ? [NOTE, ...files].join("\n\n") : "", read, left };
}
