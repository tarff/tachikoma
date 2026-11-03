// Copy mode's apply (release 7 plan, Task 19; main design, "Applying a copy-then-review session" and "Links"; choices
// 23, 25, 26 and 109): one change from the review, applied to the real project only when the real file is still as the
// snapshot found it, or, for an added file, still not there. Otherwise it is a conflict, which can be merged with git
// or skipped. Nothing is written or deleted through a link, and every replacement is backed up and logged first, so
// after a crash appliedSoFar can tell which files were applied. The box has stopped by now (release 7 design, "Copy
// mode's review and apply run on the host only after the box has stopped"), so nothing in work/ changes meanwhile.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../core/datadir.js";
import { commandEnv, onPath } from "../exec/env.js";
import { leaves } from "../tools/files.js";
import { type Change, NEVER_APPLIED } from "./changes.js";
import { hashFile, type Manifest, reserved } from "./snapshot.js";

// `mergedTo`: for a merge with conflicts, the file of conflict markers beside the real one, relative to the project.
export type Outcome = { path: string; result: "applied" | "conflict" | "skipped" | "refused"; why?: string; mergedTo?: string };
export interface ApplyContext { root: string; base: string; work: string; manifest: Manifest; session: string }
// `env` is where git is looked for and what it is run with, a test's own; `git` is a test's stand-in for the git run,
// so no fake program is planted; `step` is a test's, called at each step of a replacement, so a test can change the
// real folder there, or stop as a crash would.
export interface ApplyOptions {
  env?: NodeJS.ProcessEnv;
  git?: (args: string[], cwd: string) => Promise<{ code: number; err: string }>;
  step?: (at: "checked" | "written" | "rename" | "done") => void | Promise<void>;
}

const windows = process.platform === "win32";

const BY_HAND = "links are applied by hand";
const IGNORED = "git ignores this path; its changes are counted, never applied";
const CHANGED_SINCE = "changed in your folder since the copy was made";
const BINARY = "a binary file; resolve it by hand";
// Exported for the review, which shows it for a delete it does not offer to merge (Task 20).
export const CANNOT_MERGE = "deleted on one side, or no longer a file; resolve it by hand";
const NO_GIT = "git was not found, so it cannot be merged; resolve it by hand";
const throughLink = (part: string) => `${part} is a link, and apply never writes through one`;
const leadsOutside = (rel: string) => `${rel} leads outside your folder`;
const notAFolder = (part: string) => `${part} is not a folder, so nothing can be written in it`;
const hardLinked = (rel: string) => `${rel} has other names (hard links), so it was not replaced`;
const backupTaken = (rel: string) => `${rel} is already there and is not this file's backup; move it, then apply again`;
const markersTaken = (rel: string) => `${rel} already exists; move it, then merge again`;
// appliedSoFar's, for a change logged as begun and never logged as done (main design, "After a crash").
const NOT_APPLIED = "not applied";
const CHANGED_AFTER = "changed since";

// Of git's own variables, only these two pass to it, as in safety/gitconfig.ts: any other could change what it reads.
const KEPT = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];

// What a real path holds: nothing, a plain file (its hash, its executable flag as the snapshot reads it, and its
// permission bits), or anything else.
type Now = { kind: "none" } | { kind: "file"; sha256: string; exec: boolean; mode: number } | { kind: "other" };

// One change on its way in: the project's real place, the change's path, and where it is logged.
type Job = { root: string; rel: string; session: string; log: string; opts: ApplyOptions };

// Applies `c` to the real project, or says why not. With `merge`, a conflict is merged with git (choice 25). A failure
// to read or write, such as a full disk, rejects; what was logged then tells appliedSoFar what happened.
export async function applyChange(c: Change, ctx: ApplyContext, merge = false, opts: ApplyOptions = {}): Promise<Outcome> {
  const refused = (why: string): Outcome => ({ path: c.path, result: "refused", why });
  const conflict = (why: string): Outcome => ({ path: c.path, result: "conflict", why });
  // Compared as the snapshot and the changes compare them, so another spelling that reaches `.git` is refused too.
  if (c.path.split("/").some(reserved)) return refused(NEVER_APPLIED);
  // Links and type changes, the kinds with no `binary`, are shown only (choice 26). Told by the field, as the union is
  // not narrowed by `kind` here (checked with this repo's TypeScript).
  if (!("binary" in c)) return refused(BY_HAND);
  if (c.ignored) return refused(IGNORED);
  const root = realpathSync.native(ctx.root);
  const at = await placeOf(root, c.path, false);
  if ("why" in at) return refused(at.why);
  const now: Now = at.blocked ? { kind: "other" } : await stateOf(at.file);
  const was = Object.hasOwn(ctx.manifest.entries, c.path) ? ctx.manifest.entries[c.path] : undefined;
  const same =
    c.kind === "added" ? now.kind === "none" : now.kind === "file" && was?.type === "file" && now.sha256 === was.sha256 && now.exec === was.exec;
  const from = path.join(ctx.work, ...c.path.split("/"));
  const job: Job = { root, rel: c.path, session: ctx.session, log: path.join(path.dirname(ctx.work), "applied.jsonl"), opts };
  if (same) return replace(job, now, c.kind === "deleted" ? undefined : { file: await boxFile(from), mode: modeFor(now, c.execAfter ?? false) });
  if (c.binary) return conflict(BINARY);
  if (!merge) return conflict(CHANGED_SINCE);
  if (c.kind === "deleted" || now.kind !== "file" || !at.file) return conflict(CANNOT_MERGE);
  const exe = opts.git ? undefined : onPath("git", opts.env);
  if (!opts.git && !exe) return conflict(NO_GIT);
  const run = opts.git ?? ((args: string[], cwd: string) => git(exe!, args, cwd, opts.env ?? process.env));

  // Three copies, in a fresh folder of the copy's own in the data folder, which is outside every project the sandbox
  // accepts (choice 13): the real file as it is now, the snapshot's (empty for an added file) and the box's. Git
  // merges into the first. Its folder is removed after, by the names made in it.
  const folder = await mkdtemp(path.join(path.dirname(ctx.work), "merge-"));
  const names = ["yours", "snapshot", "box"];
  const [yours, snap, box] = names.map((name) => path.join(folder, name)) as [string, string, string];
  try {
    const before = await copyTo(at.file, yours, undefined);
    if (c.kind === "changed") await copyTo(path.join(ctx.base, ...c.path.split("/")), snap, undefined);
    else await (await open(snap, "wx")).close();
    await copyTo(await boxFile(from), box, undefined);
    const labels = ["-L", "your folder", "-L", "the snapshot", "-L", "the box's copy"];
    const ran = await run(["merge-file", ...labels, ...names], folder);
    const failed = conflict(`git merge-file failed: ${ran.err.trim().split("\n")[0] || `exit code ${ran.code}`}`);
    if (ran.code === 0) {
      // The box's executable flag when the box changed it, otherwise the real file's.
      const exec = c.execBefore !== c.execAfter ? (c.execAfter ?? false) : now.exec;
      // Awaited here, so the merge's folder is kept until it is applied.
      return await replace(job, { ...now, sha256: before }, { file: yours, mode: modeFor(now, exec) });
    }
    // Git's exit code is the number of conflicts, up to 127, and negative on an error (git-merge-file(1)).
    if (ran.code > 127) return failed;
    // A merge with conflicts always rewrites the first file, with its markers. One left as it was is a git that failed
    // with a code that reads as a count: macOS's /usr/bin/git without Apple's developer tools prints an error and exits
    // non-zero (Task 19's spec review), and its file has no markers to show.
    if ((await hashFile(yours)) === before) return failed;
    // Written only when nothing is there yet, so whatever the user keeps under that name, a link included, is never
    // written over or through. The markers have the real file's permission bits, as they hold its text.
    const markers = `${c.path}.tachikoma-merge`;
    if (await lstat(`${at.file}.tachikoma-merge`).catch(missing)) return conflict(markersTaken(markers));
    const place = await placeOf(root, markers, false);
    if ("why" in place) return refused(place.why);
    if (!place.file) return conflict(CHANGED_SINCE);
    if (!(await copyTo(yours, place.file, windows ? undefined : now.mode).catch(taken))) return conflict(markersTaken(markers));
    return { path: c.path, result: "conflict", mergedTo: markers };
  } finally {
    // A failure to remove these, such as another program briefly holding one on Windows, must not hide the outcome; a
    // folder left behind is in the copy's folder, and goes when the copy does.
    for (const file of [yours, snap, box]) await unlink(file).catch(() => undefined);
    await rmdir(folder).catch(() => undefined);
  }
}

// Each replacement, in order (plan, Task 19): the old file copied to its backup; the pending row logged, with both
// hashes; the new content written to a temporary file in the same folder's real place; the real file checked once more;
// the temporary file renamed into place; the done row logged. A delete is the same, with `after` empty and the file
// deleted instead; an added file has nothing to back up, and `before` empty. If the backup or the pending row cannot be
// written, nothing is replaced. A change that stops short of the swap removes the backup it made itself, never one an
// earlier apply made, so a merge of the file later is not refused over it.
async function replace(job: Job, now: Now, source: { file: string; mode: number | undefined } | undefined): Promise<Outcome> {
  const { root, rel, log, opts } = job;
  const before = hashOf(now)!;
  await opts.step?.("checked");
  let made: string | undefined;
  if (now.kind === "file") {
    const backedUp = await backUp(job, before, now.mode);
    if ("why" in backedUp) return { path: rel, ...backedUp };
    made = backedUp.made;
  }
  const stopped = async (result: "refused" | "conflict", why: string): Promise<Outcome> => {
    if (made) await unlink(made).catch(() => undefined);
    return { path: rel, result, why };
  };
  const after = source ? await hashFile(source.file) : "";
  await logRow(log, { path: rel, state: "pending", before, after });
  // An added file's folders are made now, each checked as it is.
  const at = await placeOf(root, rel, source !== undefined);
  if ("why" in at) return stopped("refused", at.why);
  if (!at.file) return stopped("conflict", CHANGED_SINCE);
  let temp: string | undefined;
  try {
    if (source) {
      // Named as writePrivate names its own (auth/private.ts). What is written must be what the log says.
      temp = path.join(path.dirname(at.file), `${path.basename(at.file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      if ((await copyTo(source.file, temp, source.mode)) !== after) return await stopped("conflict", CHANGED_SINCE);
    }
    await opts.step?.("written");
    const again = await placeOf(root, rel, false);
    if ("why" in again) return await stopped("refused", again.why);
    if (again.blocked || hashOf(await stateOf(again.file)) !== before) return await stopped("conflict", CHANGED_SINCE);
    await opts.step?.("rename");
    if (temp) {
      await rename(temp, at.file);
      temp = undefined;
    } else await unlink(at.file);
  } finally {
    // Only the temporary file made above, by its name; a failure to remove it must not hide the one that got here.
    if (temp) await unlink(temp).catch(() => undefined);
  }
  await opts.step?.("done");
  await logRow(log, { path: rel, state: "done" });
  return { path: rel, result: "applied" };
}

// Copies the real file to `.tachikoma/backups/<session>/<path>`, checked as any path written is. A backup already
// there from an apply a crash stopped is kept when it holds this file as it is now; anything else there is refused. The
// copy is hashed as it is made: if the file changed meanwhile, the copy is removed and the change is a conflict.
// `made`: the backup, when this call made it.
async function backUp(job: Job, before: string, mode: number): Promise<{ result: "refused" | "conflict"; why: string } | { made?: string }> {
  const rel = `.tachikoma/backups/${job.session}/${job.rel}`;
  const at = await placeOf(job.root, rel, true, true);
  if ("why" in at) return { result: "refused", why: at.why };
  const real = path.join(job.root, ...job.rel.split("/"));
  const file = at.file!; // with `make`, every folder on the way is there
  const copied = await copyTo(real, file, windows ? undefined : mode).catch(taken);
  if (copied === undefined) {
    const there = await lstat(file);
    return there.isFile() && (await hashFile(file)) === before ? {} : { result: "refused", why: backupTaken(rel) };
  }
  if (copied === before) return { made: file };
  await unlink(file);
  return { result: "conflict", why: CHANGED_SINCE };
}

// Where `rel` is in the project (plan, Task 19, "Every path apply writes or deletes"): each folder on the way is read
// without following it, and the path is refused if one is a link, or if the last folder's real place is outside the
// project, or, for a change's own path (not `ours`, Tachikoma's backups), is in `.git` or `.tachikoma` under another
// name (a short name such as GIT~1 on Windows). An existing file there must be a plain file with one name. With `make`,
// missing folders are made, one at a time, each read again once made. Where a folder is missing, the deepest one there
// is checked first, so a missing folder is never made in the wrong place, nor reported as simply missing. `blocked`: a
// folder on the way is a file, so nothing can be there; no `file`: a folder on the way is missing.
async function placeOf(root: string, rel: string, make: boolean, ours = false): Promise<{ why: string } | { file?: string; blocked?: boolean }> {
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes(path.sep))) return { why: leadsOutside(rel) };
  // The real place of a folder on the way, or why it is refused.
  const placed = async (folder: string): Promise<{ why: string } | { real: string }> => {
    const real = await realpath(folder);
    const fromRoot = path.relative(root, real);
    if (leaves(fromRoot)) return { why: leadsOutside(rel) };
    if (!ours && fromRoot.split(path.sep).some(reserved)) return { why: NEVER_APPLIED };
    return { real };
  };
  let folder = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = path.join(folder, parts[i]!);
    let st = await lstat(p).catch(missing);
    if (!st) {
      const there = await placed(folder);
      if ("why" in there) return there;
      if (!make) return {};
      await mkdir(p).catch(taken);
      st = await lstat(p);
    }
    const part = parts.slice(0, i + 1).join("/");
    if (st.isSymbolicLink()) return { why: throughLink(part) };
    if (!st.isDirectory()) return make ? { why: notAFolder(part) } : { blocked: true };
    folder = p;
  }
  const there = await placed(folder);
  if ("why" in there) return there;
  const file = path.join(there.real, parts.at(-1)!);
  const st = await lstat(file).catch(missing);
  if (st?.isSymbolicLink()) return { why: throughLink(rel) };
  if (st?.isFile() && st.nlink > 1) return { why: hardLinked(rel) };
  return { file };
}

// What the real path holds now. hashFile follows links, so the path is read with lstat first.
async function stateOf(file: string | undefined): Promise<Now> {
  const st = file ? await lstat(file).catch(missing) : undefined;
  if (!file || !st) return { kind: "none" };
  if (!st.isFile()) return { kind: "other" };
  // The owner's executable bit, as the snapshot records it (git's ce_permissions); Windows has none.
  return { kind: "file", sha256: await hashFile(file), exec: !windows && (st.mode & 0o100) !== 0, mode: st.mode & 0o777 };
}

// What a log row records for a real path: a file's hash, or empty for nothing there; undefined for anything else.
const hashOf = (now: Now) => (now.kind === "file" ? now.sha256 : now.kind === "none" ? "" : undefined);

// The permission bits of the file apply writes, set only as it is made (no file's permissions are ever changed after):
// none on Windows; a replaced file's own, with the executable bits set where it can be read, or cleared; an added
// file's as git checks one out, 777 or 666. The system takes the user's umask off each as the file is made.
function modeFor(now: Now, exec: boolean): number | undefined {
  if (windows) return undefined;
  if (now.kind !== "file") return exec ? 0o777 : 0o666;
  const plain = now.mode & ~0o111;
  return exec ? plain | 0o100 | ((plain & 0o044) >> 2) : plain;
}

// The box's copy of a file, which the changes found to be a plain file; read again here, as hashFile follows links.
async function boxFile(file: string): Promise<string> {
  if (!(await lstat(file)).isFile()) throw new Error(`${file} is no longer a file in the copy`);
  return file;
}

// Copies `src` to `dest`, a new file made only if nothing is there yet (`wx`), with `mode`, flushed to disk, and gives
// the copy's SHA-256. A copy that fails partway is removed.
async function copyTo(src: string, dest: string, mode: number | undefined): Promise<string> {
  const out = await open(dest, "wx", mode);
  const hash = createHash("sha256");
  try {
    try {
      for await (const chunk of createReadStream(src) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        for (let done = 0; done < chunk.length; ) done += (await out.write(chunk, done)).bytesWritten;
      }
      await out.sync();
    } finally {
      await out.close();
    }
  } catch (err) {
    await unlink(dest);
    throw err;
  }
  return hash.digest("hex");
}

// One row of applied.jsonl, appended and flushed to disk before the step it records goes on.
async function logRow(file: string, row: { path: string; state: "pending" | "done"; before?: string; after?: string }): Promise<void> {
  const out = await open(file, "a", 0o600);
  try {
    await out.appendFile(`${JSON.stringify(row)}\n`, "utf8");
    await out.sync();
  } finally {
    await out.close();
  }
}

// One git run from `cwd`, by its full path, with none of the user's git variables but the two naming the settings
// files, and not climbing above `cwd` for a repository (GIT_CEILING_DIRECTORIES), as gitSettings runs it. Rejects when
// git cannot be started.
function git(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; err: string }> {
  const own = Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_") || KEPT.includes(name.toUpperCase()));
  const gitEnv = { ...commandEnv(Object.fromEntries(own)), GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, env: gitEnv, windowsHide: true, encoding: "utf8" }, (error, _out, err) => {
      if (error && typeof error.code !== "number") reject(error);
      else resolve({ code: error ? (error.code as number) : 0, err });
    });
  });
}

// Which files a half-done apply reached, from applied.jsonl read against the disk (main design, "After a crash"): a
// change logged done was applied; one logged pending and never done is told by the real file's hash now: `after` means
// applied, `before` not applied, and anything else that it changed since, which is reported and never rolled back. One
// outcome per path, in the order they were begun. A half-written row, as a crash leaves, is passed over.
export async function appliedSoFar(session: string, data = dataDir()): Promise<Outcome[]> {
  const copies = path.join(data, "copies", session);
  const text = await readFile(path.join(copies, "applied.jsonl"), "utf8").catch(missing);
  if (text === undefined) return [];
  const { root } = JSON.parse(await readFile(path.join(copies, "manifest.json"), "utf8")) as Manifest;
  const rows = new Map<string, { before: string; after: string; done: boolean }>();
  for (const line of text.split("\n")) {
    const row = parse(line);
    if (row?.state === "pending") rows.set(row.path, { before: row.before, after: row.after, done: false });
    else if (row?.state === "done" && rows.has(row.path)) rows.get(row.path)!.done = true;
  }
  const out: Outcome[] = [];
  for (const [rel, row] of rows) {
    if (row.done) {
      out.push({ path: rel, result: "applied" });
      continue;
    }
    const file = path.join(root, ...rel.split("/"));
    const st = await lstat(file).catch(missing);
    const now = !st ? "" : st.isFile() ? await hashFile(file) : undefined;
    if (now === row.after) out.push({ path: rel, result: "applied" });
    else if (now === row.before) out.push({ path: rel, result: "skipped", why: NOT_APPLIED });
    else out.push({ path: rel, result: "conflict", why: CHANGED_AFTER });
  }
  return out;
}

type Row = { path: string; state: "pending"; before: string; after: string } | { path: string; state: "done" };

function parse(line: string): Row | undefined {
  try {
    const r = JSON.parse(line);
    if (typeof r?.path !== "string") return undefined;
    if (r.state === "done") return r;
    if (r.state === "pending" && typeof r.before === "string" && typeof r.after === "string") return r;
  } catch {}
  return undefined;
}

// A path that is not there, or whose folder is a file, reads as nothing there.
function missing(err: NodeJS.ErrnoException): undefined {
  if (err.code === "ENOENT" || err.code === "ENOTDIR") return undefined;
  throw err;
}

// A new file or folder whose name is already taken.
function taken(err: NodeJS.ErrnoException): undefined {
  if (err.code === "EEXIST") return undefined;
  throw err;
}
