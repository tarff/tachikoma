import { randomUUID } from "node:crypto";
import { constants, copyFileSync, type Dirent, lstatSync, mkdirSync, readdirSync, rmdirSync, type Stats, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tryLock } from "../auth/lock.js";
import { privateDir } from "../auth/private.js";
import { projectFile } from "./datadir.js";
import { readOutline, sessionPaths, wholeLines } from "./transcript.js";
import { errorText } from "./types.js";

// The saved sessions of each project (release 8a design, "Saving sessions"): <data>/sessions/<project>/ holds each
// session's <id>.jsonl, its <id>/ folder of pictures and subagents, and <id>.lock while a window has it open.

// The project's own folder, named as its error log is, after the sha256 of its real path (release 8a plan, choice 7).
// The transcript makes it private when it first writes there.
export function sessionsDir(root: string, data?: string): string {
  const file = projectFile("sessions", root, data);
  return path.join(path.dirname(file), path.basename(file, ".jsonl"));
}

export { sessionPaths } from "./transcript.js"; // kept beside the transcript, which sessions.ts reads, so no import cycles

export interface Row {
  id: string;
  name?: string;
  firstPrompt: string;
  lead: string;
  changed: Date;
  size: number;
  print: boolean;
}

// A folder's entries with their types, none when it is not there. Each entry has one type, so a link, a junction
// included, is never a folder or a file here. Links are judged by these types, never by lstat, which on Windows follows a
// junction to another volume.
function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// The folder's entry of that name, with its own type, or none.
export const entryOf = (dir: string, name: string): Dirent | undefined => entries(dir).find((e) => e.name === name);

// Newest first, leaving out sessions with no messages, ones that cannot be read, and -p runs unless `print` asks for them,
// as `tachi -p --continue` does (release 8a plan, choice 9).
export function listSessions(dir: string, opts: { print: boolean }): Row[] {
  const rows: Row[] = [];
  for (const e of entries(dir)) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const id = path.basename(e.name, ".jsonl");
    const file = path.join(dir, e.name);
    const r = readOutline(file);
    if (!r?.said || (r.print && !opts.print)) continue;
    let st: Stats;
    try {
      st = statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // deleted since, by another launch's sweep
      throw err;
    }
    rows.push({ id, name: r.name, firstPrompt: r.firstPrompt ?? "", lead: r.lead, changed: st.mtime, size: st.size, print: r.print });
  }
  return rows.sort((a, b) => b.changed.getTime() - a.changed.getTime());
}

// The session with that exact id, else the one with that name, or every one with it, newest first, when more than one has
// it: those open the list filtered to them (release 8a design, "Resuming"). -p runs are found too, as `-p -r` takes an
// id or a name (choice 12).
export function findSession(dir: string, idOrName: string): Row | Row[] | null {
  const rows = listSessions(dir, { print: true });
  const named = rows.filter((r) => r.name === idOrName);
  return rows.find((r) => r.id === idOrName) ?? (named.length > 1 ? named : (named[0] ?? null));
}

// The session's open lock, taken without waiting, or null while another window holds it (choice 8).
export function openSession(dir: string, id: string): { release: () => void } | null {
  const release = tryLock(path.join(dir, `${id}.lock`));
  return release && { release };
}

// A copy under a new id, of everything saved so far: the transcript's whole lines, its start line naming the copy, and the
// <id>/ folder, each subagent's file as its whole lines too, so a finished subagent still reads as finished (release 8a
// plan, Task 4; design, "Names, branches and export"). A line the other window is still writing is left out (design,
// "When something goes wrong"). A copy that fails partway is removed, its folder before its transcript, as the sweep
// removes a session (release 8a plan, Task 6), and only what it made: a cleanup that fails leaves the leftover to the
// sweep, and the copy's own error is the one thrown. A source whose first line cannot be read throws
// Unreadable, so the caller can tell a session it cannot read from a copy it cannot write. `copy` is the
// new id: openSaved gives the one whose lock it already holds.
export function copySession(dir: string, id: string, copy: string = randomUUID()): string {
  privateDir(dir);
  const [from, to] = [sessionPaths(dir, id), sessionPaths(dir, copy)];
  const text = wholeLines(from.file);
  const end = text.indexOf("\n") + 1; // after the start line, written first (choice 4)
  let first: object;
  try {
    first = JSON.parse(text.slice(0, end));
  } catch {
    throw new Unreadable("its first line is missing or damaged"); // readTranscript's reason (user, 2026-11-06)
  }
  writeFileSync(to.file, `${JSON.stringify({ ...first, id: copy })}\n${text.slice(end)}`, { flag: "wx", mode: 0o600 });
  let made = false; // the copy's folder, once this made it
  try {
    if (entryOf(dir, id)?.isDirectory()) {
      mkdirSync(path.dirname(to.pictures), { mode: 0o700 });
      made = true;
      copyInto(path.dirname(from.pictures), path.dirname(to.pictures));
    }
  } catch (err) {
    try {
      if (made) removeSession(dir, copy);
      else unlinkSync(to.file);
    } catch {}
    throw err;
  }
  return copy;
}

export class Unreadable extends Error {}

// A session's folder, then its transcript, as the sweep removes them: the folder read with file types, a link in it
// unlinked, never entered (release 8a plan, "Rules for every task"). For a copy Tachikoma made and cannot use.
export function removeSession(dir: string, id: string): void {
  const folder = entryOf(dir, id);
  if (folder) remove(path.join(dir, id), folder);
  unlinkSync(sessionPaths(dir, id).file);
}

// Links are left out, never followed, so a copy holds only what Tachikoma saved there (release 8a plan, Task 4).
function copyInto(from: string, to: string): void {
  for (const e of entries(from)) {
    const [a, b] = [path.join(from, e.name), path.join(to, e.name)];
    if (e.isDirectory()) {
      mkdirSync(b, { mode: 0o700 });
      copyInto(a, b);
    }
    else if (e.isFile() && e.name.endsWith(".jsonl")) writeFileSync(b, wholeLines(a), { flag: "wx", mode: 0o600 });
    else if (e.isFile()) copyFileSync(a, b, constants.COPYFILE_EXCL);
  }
}

// A day in milliseconds: 24 hours of 3,600 seconds.
const DAY = 24 * 60 * 60 * 1000;

// Deletes every project's sessions left unchanged for `days` days, once per launch (release 8a plan, choice 10). A session
// open in another window is kept: its lock is taken first, and its age checked again under it, so one resumed since the
// first look is kept too. The folder goes before the transcript, so a session that could not be removed whole is still
// found by the next sweep. Returns one line for each session or folder that could not be deleted; the launch goes on.
export function sweep(data: string, days: number, now: Date): string[] {
  const lines: string[] = [];
  const failed = (file: string, err: unknown) => lines.push(`An old session could not be deleted: ${file} (${errorText(err)}).`);
  const top = path.join(data, "sessions");
  const look = (dir: string) => {
    try {
      return entries(dir);
    } catch (err) {
      failed(dir, err);
      return [];
    }
  };
  for (const project of look(top)) {
    if (!project.isDirectory()) continue;
    const dir = path.join(top, project.name);
    const inside = look(dir);
    for (const e of inside) {
      if (!e.name.endsWith(".jsonl")) continue;
      const id = path.basename(e.name, ".jsonl");
      const file = path.join(dir, e.name);
      // Gone already counts as not old: another launch's sweep took it.
      const old = () => {
        try {
          return now.getTime() - lstatSync(file).mtimeMs >= days * DAY;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw err;
        }
      };
      let release: (() => void) | null = null;
      try {
        if (!old() || !(release = tryLock(path.join(dir, `${id}.lock`))) || !old()) continue;
        removeSession(dir, id);
      } catch (err) {
        failed(file, err);
      } finally {
        release?.();
      }
    }
  }
  return lines;
}

// A link is unlinked, never entered (release 8a plan, "Rules for every task").
function remove(p: string, e: Dirent): void {
  if (e.isDirectory()) {
    for (const inner of readdirSync(p, { withFileTypes: true })) remove(path.join(p, inner.name), inner);
    rmdirSync(p);
  } else unlinkSync(p);
}
