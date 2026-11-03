// Copy mode's snapshot (release 7 plan, Task 17; main design, "Applying a copy-then-review session" and "Links"; choices
// 23 and 24). The project is copied exactly as it is, untracked and ignored files included, into `base/`, which is kept
// as it was, and `work/`, which the box gets as /work, both in a private folder of Tachikoma's data folder. Every `.git`
// and `.tachikoma`, folder or file, at any depth, is left out: the box makes its own repository, and neither is ever
// applied back. No link is followed: one leading inside the project is made again in each copy, pointing at the same
// place there; any other is left out, with its why.
import { createHash } from "node:crypto";
import { type BigIntStats, createReadStream, realpathSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readlink, rmdir, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { privateDir, writePrivate } from "../auth/private.js";
import { dataDir } from "../core/datadir.js";
import { fold } from "../safety/protected.js";
import { leaves } from "../tools/files.js";

// Each path is the project's own, its parts joined by `/` on every system. A link's `target` is the one stored in the
// project, as written there, to show; `inCopy` is the one work/ holds, read back after it was made, which the changes
// compare work/ against (Task 18), so a rewritten target never shows as a change (main design, "Links"). For a link kept
// as written the two are the same. A file's `size` and `mtimeMs` are work/'s copy's, read just after it was made: the
// changes compare a git-ignored file by them instead of its hash (choice 112).
export interface Manifest { session: string; root: string; at: string; entries: Record<string, ManifestEntry>; leftOut: { path: string; why: string }[] }
export type ManifestEntry =
  | { type: "file"; sha256: string; exec: boolean; size: number; mtimeMs: number }
  | { type: "folder" }
  | { type: "link"; target: string; inCopy: string };

export class SnapshotRefused extends Error {}

const windows = process.platform === "win32";

// Compared as protected.ts reads a name (letter case folded on Windows and macOS, Windows' trailing dots and spaces
// dropped), so another spelling of `.git` that reaches it is left out too (choice 104's measurement), as Task 19 refuses
// it.
const RESERVED = [".git", ".tachikoma"];
export const reserved = (name: string) => RESERVED.includes(fold(name, process.platform));

const LEADS_OUTSIDE = "a link that leads outside the project";
const LEADS_NOWHERE = "a link that leads nowhere";
export const NOT_COPIED = "not a file, folder or link";

// Copies `root` into `<data>/copies/<session>/`, and writes manifest.json there last. `copied` is a test's, called after
// each file is copied and before it is hashed again.
export async function snapshot(
  root: string,
  session: string,
  data = dataDir(),
  opts: { copied?: (path: string) => void | Promise<void> } = {},
): Promise<{ manifest: Manifest; base: string; work: string }> {
  const real = realpathSync.native(root);
  const copies = path.join(data, "copies", session);
  privateDir(copies); // first, so on Windows base/ and work/ take its owner-only permission as they are made
  const base = path.join(copies, "base");
  const work = path.join(copies, "work");
  // Not recursive: a copy is never made into one already there.
  await mkdir(base);
  await mkdir(work);
  // No prototype, so a file named `__proto__` is an entry like any other, not the object's prototype.
  const manifest: Manifest = { session, root: real, at: new Date().toISOString(), entries: Object.create(null), leftOut: [] };
  const links: string[] = [];

  const walk = async (rel: string): Promise<void> => {
    const from = path.join(real, ...rel.split("/"));
    for (const d of await readdir(from, { withFileTypes: true })) {
      if (reserved(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      const src = path.join(from, d.name);
      const to = (copy: string) => path.join(copy, ...r.split("/"));
      // Windows lists every reparse point as a link, including ones that are not, such as a cloud file; only one with a
      // target is a link, and lstat says what the others are.
      const target = d.isSymbolicLink() ? await readlink(src).catch(() => undefined) : undefined;
      if (target !== undefined) {
        const why = await remake(src, from, target, (place, folder) => Promise.all([base, work].map((copy) => linkIn(copy, to(copy), target, place, folder))));
        if (why) manifest.leftOut.push({ path: r, why });
        else {
          manifest.entries[r] = { type: "link", target, inCopy: await readlink(to(work)) };
          links.push(r);
        }
        continue;
      }
      const kind = d.isSymbolicLink() ? await lstat(src).catch(unreadable) : d;
      if (kind?.isDirectory()) {
        await mkdir(to(base));
        await mkdir(to(work));
        manifest.entries[r] = { type: "folder" };
        await walk(r);
      } else if (kind?.isFile()) manifest.entries[r] = await copyFile(src, r, [to(base), to(work)], opts.copied);
      else manifest.leftOut.push({ path: r, why: NOT_COPIED });
    }
  };

  // Where a link stored as `target` really leads, after every link on the way. Inside the project, `make` is given that
  // place, relative to the project, and whether it is a folder; otherwise the why it is left out. A relative target is
  // also read as text, its `..` steps taken from the link's folder: one that climbs above the project that way is left
  // out, even when its real place is inside (through a link outside that leads back in), as the same text in the copy
  // would climb out of the copy. One that climbs back in by the project folder's own name (`../proj/src`) reads as
  // inside and is kept as written, so in the copy it leads nowhere.
  const remake = async (src: string, from: string, target: string, make: (place: string, folder: boolean) => Promise<unknown>) => {
    let place: string;
    try {
      place = realpathSync.native(src);
    } catch {
      return LEADS_NOWHERE;
    }
    if (leaves(path.relative(real, place))) return LEADS_OUTSIDE;
    if (!path.isAbsolute(target) && leaves(path.relative(real, path.resolve(from, target)))) return LEADS_OUTSIDE;
    await make(path.relative(real, place), (await stat(src)).isDirectory());
    return undefined;
  };

  await walk("");
  // Every link in work/ is one made above: the rest are files and folders made new. Each must still resolve inside
  // work/, or the box could reach the real folder through it (main design, "Links"). One that leads nowhere leads
  // nowhere outside either.
  const realWork = realpathSync.native(work);
  for (const r of links) {
    let place: string;
    try {
      place = realpathSync.native(path.join(work, ...r.split("/")));
    } catch {
      continue;
    }
    if (leaves(path.relative(realWork, place))) throw new SnapshotRefused(`The copy was refused: the link ${r} in it leads outside the copy.`);
  }
  writePrivate(path.join(copies, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, base, work };
}

// Makes the link at `at` in `copy`, to `place` (relative to the project) there. A relative target is kept as written,
// which leads to the same place in the copy. An absolute one is rewritten: on Windows a folder's becomes a junction to
// the copy's absolute path, as a junction must be absolute and needs no special rights; any other is written relative,
// so it also holds in the box, where the copy is /work.
async function linkIn(copy: string, at: string, target: string, place: string, folder: boolean): Promise<void> {
  const type = folder ? "dir" : "file"; // Windows needs the kind; other systems ignore it
  if (!path.isAbsolute(target)) return symlink(target, at, type);
  const there = path.join(copy, place);
  if (windows && folder) return symlink(there, at, "junction");
  return symlink(path.relative(path.dirname(at), there) || ".", at, type);
}

// Copies a file into each of `to` and gives its entry. The project is read once, into every copy and the hash at once,
// then read again: a file that changed meanwhile, or is gone, is copied and hashed again, and if it changes again the
// snapshot is refused (main design, "Files that change during copying").
async function copyFile(src: string, rel: string, to: string[], copied?: (path: string) => void | Promise<void>): Promise<ManifestEntry> {
  for (let tries = 1; ; tries++) {
    const st = await lstat(src, { bigint: true }).catch(gone);
    const sha256 = st?.isFile() ? await copyOnce(src, st, to, tries === 1 ? "wx" : "w") : undefined;
    // work/'s copy, the last of `to`, as it was just made.
    const copy = sha256 === undefined ? undefined : await lstat(to.at(-1)!);
    await copied?.(rel);
    if (st && sha256 !== undefined && copy && sha256 === (await hashFile(src).catch(gone))) {
      // The owner's executable bit, as git reads it (git's read-cache.c, ce_permissions). Windows has none.
      return { type: "file", sha256, exec: !windows && (st.mode & 0o100n) !== 0n, size: copy.size, mtimeMs: copy.mtimeMs };
    }
    if (tries === 2) {
      throw new SnapshotRefused(`The project would not hold still while it was copied (${rel} kept changing); try again when nothing is writing to it.`);
    }
  }
}

// An entry listed as a link that is none, and that lstat cannot read either: Docker Desktop on Windows keeps a socket
// or pipe a box made that way (measured on Windows at Task 18's quality review: readlink fails with EINVAL, lstat with
// EACCES). It is not a file, folder or link, and is left out as one, rather than failing the copy or the changes.
export function unreadable(err: NodeJS.ErrnoException): undefined {
  if (err.code === "EACCES") return undefined;
  throw err;
}

// A file that is gone counts as one that changed.
function gone(err: NodeJS.ErrnoException): undefined {
  if (err.code === "ENOENT") return undefined;
  throw err;
}

// One read of `src` into each of `to` (new files, never links to it) and the hash, streamed, so a big file is never
// held whole. Undefined when what was opened is not the file `st` describes: it was replaced meanwhile, perhaps by a
// link, which is never followed. `flags` is "wx" the first time, so nothing already there is written over, and "w" when
// the copies made then are written again. On other systems a copy keeps the file's permission bits, its executable
// flag among them; on Windows the default, as a read-only mode would make the copy read-only there.
async function copyOnce(src: string, st: BigIntStats, to: string[], flags: string): Promise<string | undefined> {
  const from = await open(src, "r").catch(gone);
  if (!from) return undefined;
  try {
    const now = await from.stat({ bigint: true });
    if (now.dev !== st.dev || now.ino !== st.ino) return undefined;
    const outs: FileHandle[] = [];
    try {
      for (const file of to) outs.push(await open(file, flags, windows ? undefined : Number(st.mode & 0o777n)));
      const hash = createHash("sha256");
      for await (const chunk of from.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        for (const out of outs) await writeAll(out, chunk);
      }
      return hash.digest("hex");
    } finally {
      for (const out of outs) await out.close();
    }
  } finally {
    await from.close();
  }
}

async function writeAll(out: FileHandle, chunk: Buffer): Promise<void> {
  for (let done = 0; done < chunk.length; ) done += (await out.write(chunk, done)).bytesWritten;
}

// Removes a copy's folder (`copies/<session>/`) and all it holds, for the review (Task 20). manifest.json goes first, so
// a copy that cannot be removed whole is never listed or applied half removed. No link is followed: each folder is read
// by its entries' types as readdir gives them, and a link, a Windows junction, or a box's socket or pipe (which Windows
// lists as a link, unreadable; the host can remove one, measured with Docker Desktop at Task 20) is removed as the entry
// it is, never entered. lstat is not asked, as on Windows it can follow a junction to a volume named by its ID.
export async function removeCopy(folder: string): Promise<void> {
  await unlink(path.join(folder, "manifest.json")).catch(gone);
  const remove = async (dir: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await remove(p);
      else await unlink(p);
    }
    await rmdir(dir);
  };
  await remove(folder);
}

// A file's SHA-256, streamed. Copy mode's later steps hash the real files with it too.
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}
