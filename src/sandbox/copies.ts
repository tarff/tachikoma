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
import { appliedSoFar, type ToReview, toReview } from "./apply.js";
import { docker, type DockerRun } from "./docker.js";
import { alive, sessionGone } from "./executor.js";
import { copyLock, MANIFEST, type Manifest, removeCopy } from "./snapshot.js";

// The plan's words (Task 21).
const NONE = "No copies are waiting.";
const busy = (name: string) => `The copy ${name} is still in use by a running Tachikoma session; review it after that session ends.`;
// The rest are the user's (Task 21's spec review): the list's head, its rows' change count and its row when the changes
// cannot be read; the usage; an unknown name; no terminal; the wait for another review; a half-done apply's report (main
// design, "After a crash").
const LISTED = "Copies waiting for review (tachi review <name> opens one):";
const counted = (n: number) => `${n} change${n === 1 ? "" : "s"}`;
const uncounted = (why: string) => `changes unreadable (${why})`;
const USAGE = "Usage: tachi review [<name> [--discard]]";
const unknown = (name: string) => `No copy named ${name} is waiting; tachi review lists them.`;
const noTerminal = (name: string) => `tachi review ${name} needs a terminal; with none, nothing is applied or discarded.`;
const WAITING = "Another review of this copy is open; waiting for it to end...";
// The user's (Task 21's quality review): discard's line when the box cannot be removed, before the kept line.
const NOT_DISCARDED = "The box could not be removed, so the copy was not discarded.";
const appliedBefore = (paths: string[]) => `An earlier apply of this copy applied: ${paths.join(", ")}`;
const changedSince = (paths: string[]) => `Changed in your folder since an earlier apply began on it, so left as it is: ${paths.join(", ")}`;
// The user's (choice 121): a copy session's end with nothing to review.
const NOTHING_CHANGED = "Nothing changed in the copy, so it was removed.";
const onlyIgnored = (n: number) => `Nothing to review (${counted(n)} only in paths git ignores, never applied), so the copy was removed.`;

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
  remove?: (folder: string) => Promise<void>; // a test's stand-in for removeCopy
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
    if (box === "busy") io.err(busy(name));
    else if (box === "stuck" && discard) {
      io.err(NOT_DISCARDED);
      io.err(kept(name));
    } else if (box === "stuck") io.err(NOT_GONE);
    if (box !== "free") return 1;
    return discard ? discardCopy(copy, data, io) : openCopy(copy, data, io);
  }, () => io.out(WAITING));
}

// Each copy with its project folder, when it was made, and how many changes the review would list (apply.ts, toReview),
// oldest first. Each row is said once counted, as a copy holding a large project takes a second or two (measured at Task
// 21: 1.2-1.8 s on this repo's 15,336 entries).
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
      n = counted((await toReview(c.manifest, c.folder, c.session)).changes.length);
    } catch (err) {
      n = uncounted(errorText(err));
    }
    io.out(visible(`  ${c.session}  ${c.manifest.root}  ${when(c.manifest.at)}  ${n}`));
  }
  return 0;
}

// Local time, to the minute, the same on every system.
function when(iso: string): string {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// The copies in the data folder: each folder in copies/ whose manifest.json can be read. One without, a copy whose launch
// has not kept it yet (its manifest under its holding name, snapshot.ts, PENDING), a snapshot stopped midway, or a copy
// half removed (removeCopy deletes the manifest first), is not a copy, and is never listed, opened or discarded here.
// The locks beside the copies are files, not folders.
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
    const m = JSON.parse(await readFile(path.join(folder, MANIFEST), "utf8")) as Manifest;
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
  await earlierApply(copy, data, io);
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

// What an earlier apply of the copy did, from its log read against the folder (main design, "After a crash"): the files
// it applied, and those it began on that the user has changed since. Said before a review, and before a discard, as both
// stay in the project.
async function earlierApply(copy: ReviewCopy, data: string, io: ReviewIo): Promise<void> {
  const before = await appliedSoFar(copy.session, data);
  const applied = before.filter((o) => o.result === "applied").map((o) => o.path);
  const since = before.filter((o) => o.result === "conflict").map((o) => o.path);
  if (applied.length) io.out(visible(appliedBefore(applied)));
  if (since.length) io.out(visible(changedSince(since)));
}

// Review's own question and lines (Task 20), asked and said here, after what an earlier apply did. Once begun, the
// removal goes on through Ctrl-C, as the review's own does (uninterrupted).
async function discardCopy(copy: ReviewCopy, data: string, io: ReviewIo): Promise<number> {
  await earlierApply(copy, data, io);
  if (!(await io.ask!(discardAsked("y/n")))) {
    io.out(kept(copy.session));
    return 0;
  }
  io.out(removing(Object.values(copy.manifest.entries).filter((e) => e.type === "file").length));
  try {
    await uninterrupted(() => (io.remove ?? removeCopy)(copy.folder));
  } catch (err) {
    io.err(visible(notRemoved(errorText(err), copy.folder)));
    return 1;
  }
  io.out(DISCARDED);
  return 0;
}

// Choice 121 (the user's): a copy session that ends with nothing to review, no change the review would list (apply.ts,
// toReview) and nothing the box left that it notes as never applied, skips the review and removes the copy, at the session's end (queue.ts, leave) and with -p (cli.tsx), each
// once the box is gone and under the copy's lock. Gives the line to print, the copy removed or why not; or, with
// something to review, what toReview gave, so the review does not read it again; or undefined when it cannot be read,
// for the review to say why, or -p to keep the copy, as before. `say` gives the removing line first, as a copy holding
// node_modules takes a while; once begun, the removal goes on through Ctrl-C, as discard's does.
export async function dropIfNothing(copy: ReviewCopy, say: (line: string) => void, remove: (folder: string) => Promise<void> = removeCopy): Promise<string | ToReview | undefined> {
  let found: ToReview;
  try {
    found = await toReview(copy.manifest, copy.folder, copy.session);
  } catch {
    return undefined;
  }
  // What the box left in work/ that is never applied, a deeper .git or a .tachikoma, is listed in the review as a note,
  // for the user to see before it is deleted, so it keeps the review; the box's own repository at the top does not, as
  // the review does not list it (choice 114), nor does what the launch left out, said at launch.
  if (found.changes.length || found.leftOut.some((l) => l.path !== ".git")) return found;
  say(removing(Object.values(copy.manifest.entries).filter((e) => e.type === "file").length));
  try {
    await uninterrupted(() => remove(copy.folder));
  } catch (err) {
    return visible(notRemoved(errorText(err), copy.folder));
  }
  return found.ignored ? onlyIgnored(found.ignored) : NOTHING_CHANGED;
}

// Runs `fn` with Ctrl-C set aside: removeCopy deletes the manifest first, so a copy stopped midway is never listed again,
// and is left for deleting by hand. Every SIGINT listener (cli.tsx's, which exits) is taken off and one that does
// nothing put in their place, so neither the first Ctrl-C nor a second gets Node's default exit; they are put back after.
async function uninterrupted<T>(fn: () => Promise<T>): Promise<T> {
  const listeners = process.listeners("SIGINT");
  const ignore = () => {};
  process.on("SIGINT", ignore); // first, so SIGINT never has no listener, which would bring back the default exit
  for (const l of listeners) process.off("SIGINT", l);
  try {
    return await fn();
  } finally {
    for (const l of listeners) process.on("SIGINT", l);
    process.off("SIGINT", ignore);
  }
}
