// `tachi review` (release 7 plan, Task 21; choice 28): the copies copy mode keeps for review, listed, opened or discarded
// from the command line. A copy is opened or discarded only under the lock beside it (withLock, copyLock), so two reviews
// of one copy take turns, and only once no box of its session is running for a live session (release 7 design: review and
// apply "run on the host only after the box has stopped"). Docker is reached only through a DockerRun (choice 69), and the
// terminal through `ask` and `open`, so tests touch neither.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { withLock } from "../auth/lock.js";
import { protectionOf } from "../clilib.js";
import { dataDir } from "../core/datadir.js";
import { type Protection, visible } from "../core/permissions.js";
import { errorText } from "../core/types.js";
import { type GitSettings, gitSettings } from "../safety/gitconfig.js";
import { NOT_GONE, reviewUnopened } from "../tui/app/constants.js";
import { DISCARDED, discardAsked, kept, notRemoved, removing, type ReviewCopy, type ReviewEnd } from "../tui/Review.js";
import { appliedSoFar } from "./apply.js";
import { changes } from "./changes.js";
import { docker, type DockerRun } from "./docker.js";
import { alive, sessionGone } from "./executor.js";
import { copyLock, type Manifest, removeCopy } from "./snapshot.js";

// The plan's words (Task 21).
const NONE = "No copies are waiting.";
const busy = (name: string) => `The copy ${name} is still in use by a running Tachikoma session; review it after that session ends.`;
// WORDING: needs approval (the list's head, its rows' change count, and its row when the changes cannot be read).
const LISTED = "Copies waiting for review (tachi review <name> opens one):";
const counted = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
const uncounted = (why: string) => `changes unreadable (${why})`;
// WORDING: needs approval.
const USAGE = "Usage: tachi review [<name> [--discard]]";
// WORDING: needs approval.
const unknown = (name: string) => `No copy named ${name} is waiting; tachi review lists them.`;
// WORDING: needs approval.
const noTerminal = (name: string) => `tachi review ${name} needs a terminal; with none, nothing is applied or discarded.`;
// WORDING: needs approval (while another review of the copy holds its lock).
const WAITING = "Another review of this copy is open; waiting for it to end...";
// WORDING: needs approval (a half-done apply's report, main design "After a crash").
const appliedBefore = (paths: string[]) => `An earlier apply of this copy applied: ${paths.join(", ")}`;
const changedSince = (paths: string[]) => `Changed in your folder since an earlier apply began on it, so left as it is: ${paths.join(", ")}`;

// How the command reaches the user, Docker and git. `ask` and `open` only with a terminal: the discard's y/n question,
// and the review drawn in full screen (cli.tsx), resolving once the screen is gone. `data` is a test's data folder.
export interface ReviewIo {
  out: (line: string) => void;
  err: (line: string) => void;
  ask?: (question: string) => Promise<boolean>;
  open?: (copy: ReviewCopy, protection: Protection) => Promise<ReviewEnd>;
  run?: DockerRun;
  gitSettings?: (root: string) => Promise<GitSettings | undefined>;
  data?: string;
}

// `tachi review` lists the copies waiting, `tachi review <name>` opens one, and `tachi review <name> --discard` discards
// one after asking. The exit code: 0, or 1 when nothing was done.
export async function reviewCommand(args: string[], io: ReviewIo): Promise<number> {
  const data = io.data ?? dataDir();
  const [name, flag, ...rest] = args;
  if (name === undefined) return list(data, io);
  if (name.startsWith("-") || rest.length || (flag !== undefined && flag !== "--discard")) {
    io.err(USAGE);
    return 1;
  }
  const discard = flag !== undefined;
  if (!(await copyNamed(name, data))) {
    io.err(visible(unknown(name)));
    return 1;
  }
  if (!io.open || !io.ask) {
    io.err(visible(noTerminal(name)));
    return 1;
  }
  return withLock(copyLock(path.join(data, "copies", name)), async () => {
    // Read again once the lock is held: the review waited for may have removed it.
    const copy = await copyNamed(name, data);
    if (!copy) {
      io.err(visible(unknown(name)));
      return 1;
    }
    const box = await boxCheck(copy.manifest, io.run);
    if (box !== "free") {
      io.err(box === "busy" ? busy(name) : NOT_GONE);
      return 1;
    }
    return discard ? discardCopy(copy, io) : openCopy(copy, data, io);
  }, () => io.out(WAITING));
}

// Each copy with its project folder, when it was made, and how many changes the review would list (changes(), less what
// git ignores and what an earlier apply applied), oldest first. Each row is said once counted, as a copy holding a large
// project takes a second or two (measured at Task 21: 1.2-1.8 s on this repo's 15,336 entries).
async function list(data: string, io: ReviewIo): Promise<number> {
  const copies = await copiesWaiting(data);
  if (!copies.length) {
    io.out(NONE);
    return 0;
  }
  io.out(LISTED);
  for (const c of copies.sort((a, b) => (a.manifest.at < b.manifest.at ? -1 : a.manifest.at > b.manifest.at ? 1 : 0))) {
    let n: string;
    try {
      n = counted(await changeCount(c, data));
    } catch (err) {
      n = uncounted(errorText(err));
    }
    io.out(visible(`  ${c.session}  ${c.manifest.root}  ${when(c.manifest.at)}  ${n}`));
  }
  return 0;
}

// What the review would list: Review.tsx reads the changes the same way.
async function changeCount(c: ReviewCopy, data: string): Promise<number> {
  const [found, before] = await Promise.all([changes(c.manifest, path.join(c.folder, "work")), appliedSoFar(c.session, data)]);
  const applied = new Set(before.filter((o) => o.result === "applied").map((o) => o.path));
  return found.changes.filter((ch) => !ch.ignored && !applied.has(ch.path)).length;
}

// Local time, to the minute, the same on every system.
function when(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// The copies in the data folder: each folder in copies/ whose manifest.json can be read. One without, a snapshot still
// being made or stopped midway, or a copy half removed (removeCopy deletes the manifest first), is not a copy, and is
// never listed, opened or discarded here. The locks beside the copies are files, not folders.
async function copiesWaiting(data: string): Promise<ReviewCopy[]> {
  const copies = path.join(data, "copies");
  const entries = await readdir(copies, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const found: ReviewCopy[] = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const manifest = await manifestIn(path.join(copies, d.name));
    if (manifest) found.push({ session: d.name, folder: path.join(copies, d.name), manifest });
  }
  return found;
}

// A copy by its name exactly as listed, so a name is never read as a path.
async function copyNamed(name: string, data: string): Promise<ReviewCopy | undefined> {
  return (await copiesWaiting(data)).find((c) => c.session === name);
}

async function manifestIn(folder: string): Promise<Manifest | undefined> {
  try {
    const m = JSON.parse(await readFile(path.join(folder, "manifest.json"), "utf8")) as Manifest;
    const ok = typeof m?.root === "string" && typeof m.at === "string" && typeof m.entries === "object" && m.entries !== null && Array.isArray(m.leftOut);
    return ok ? m : undefined;
  } catch {
    return undefined;
  }
}

// Whether the copy's box is out of the way (release 7 plan, Task 21), asked of Docker by the session's label
// (DockerExecutor.start): "busy" while a box runs and the session's process is alive, as that session may still be
// writing to the copy; otherwise every box of the session is removed (a crash's, or one that stopped), and "stuck" when
// Docker still lists one after. With Docker not running or not installed, no box can be running: "free". The session's
// process is the manifest's pid: this process's own is never alive here, as leave() checks its own copy as it ends
// (cli.tsx), and `tachi review` can only have that pid once the session's process is gone. A pid the system has since
// given to another program reads as alive, so a crash's still-running box then refuses the review until that program
// ends or the box is removed by hand, as the launch's sweep leaves such a box (sweepBoxes).
export async function boxCheck(manifest: Manifest, run: DockerRun = docker): Promise<"free" | "busy" | "stuck"> {
  const label = `label=tachikoma.session=${manifest.session}`;
  const ids = async (all: boolean) => {
    const got = await run(["ps", ...(all ? ["-a"] : []), "-q", "--filter", label]).catch(() => "missing" as const);
    return got === "missing" || got.code !== 0 ? undefined : got.out.split("\n").map((l) => l.trim()).filter(Boolean);
  };
  const running = await ids(false);
  if (running === undefined) return "free";
  const pid = manifest.pid;
  if (running.length && Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) return "busy";
  const listed = await ids(true);
  if (!listed?.length) return "free";
  await run(["rm", "-f", ...listed]).catch(() => {});
  return (await sessionGone(manifest.session, run)) ? "free" : "stuck";
}

// The half-done apply's report first, then the review, with the protection git's settings name on the host (as leave()
// works it out); without them, no review, as at the session's end. The review's lines are printed once its screen is gone.
async function openCopy(copy: ReviewCopy, data: string, io: ReviewIo): Promise<number> {
  const before = await appliedSoFar(copy.session, data);
  const applied = before.filter((o) => o.result === "applied").map((o) => o.path);
  const since = before.filter((o) => o.result === "conflict").map((o) => o.path);
  if (applied.length) io.out(visible(appliedBefore(applied)));
  if (since.length) io.out(visible(changedSince(since)));
  let protection: Protection;
  try {
    protection = protectionOf(await (io.gitSettings ?? gitSettings)(copy.manifest.root));
  } catch (err) {
    io.err(visible(reviewUnopened(errorText(err))));
    io.err(kept(copy.session));
    return 1;
  }
  const end = await io.open!(copy, protection);
  for (const line of end.lines) io.out(line);
  return 0;
}

// Review's own question and lines (Task 20), asked and said here.
async function discardCopy(copy: ReviewCopy, io: ReviewIo): Promise<number> {
  if (!(await io.ask!(discardAsked("y/n")))) {
    io.out(kept(copy.session));
    return 0;
  }
  io.out(removing(Object.values(copy.manifest.entries).filter((e) => e.type === "file").length));
  try {
    await removeCopy(copy.folder);
  } catch (err) {
    io.err(visible(notRemoved(errorText(err), copy.folder)));
    return 1;
  }
  io.out(DISCARDED);
  return 0;
}
