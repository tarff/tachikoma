// The tests' remover (cleanup plan, step 4): removes a folder a test made, and gives back what it could not remove.
//
// Who may use it: tests, on folders a test made. It must not be pointed at folders of unknown history, and it is never
// what deletes in the user's real Temp: the one-off script deletes there only by a way measured on CI and shown by its
// own tests (cleanup plan, steps 14e and 21).
//
// How it reads a type: always from the listing of the folder that holds the entry, never by a status call on the
// entry itself, which on Windows follows a junction that names its drive by ID (src/core/sessions.ts). Before a
// folder's contents are deleted or entered, its holder's listing is read again (the second look); a folder that then
// shows as a link, a file, or not at all is changed, and is left with everything above it.
//
// What its looks show. Each look shows one thing: at that moment, the path as written led to a listing in which the
// name had that type. So:
// - Held: a root that is a link when looked at is not followed. A link that is in a listing when it is first read is
//   not followed. A folder that has itself been replaced by a link and is still a link at the second look is not
//   deleted from, then or on any later try.
// - Not held, and not claimed:
//   - Reading: the second look comes after the folder's own listing has been read, so the remover may read the
//     listing of whatever a swapped-in link points at. It deletes nothing from that listing, but reading through a
//     link is not prevented.
//   - The same folder: that the path still leads to the same folder as before is not shown. If a folder above the one
//     being looked at has been swapped for a junction, both looks go through that junction and can show a plain
//     folder; deletes then land behind the junction.
//   - A moment's junction: if a folder is a junction only between the two looks and is put back before the second,
//     the listing read in between was the junction's target and is deleted from.
//   - Afterwards: anything swapped after the second look is not seen.
//   In short, the remover does not keep its walk inside the folder it was given if another program changes folders
//   under it while it runs. That is acceptable for tests and nowhere else: a test's folder was made by that test a
//   moment ago under a random name, and the only programs changing it are the test's own.
//
// A changed entry is final for the whole removal: no later try touches it again, whatever type it shows by then, and
// it is never removed as a link. A try that is refused (on CI every refusal was EBUSY) is made again from the root
// after `pause` ms, until `limit` ms have passed since the first; a limit of 0 makes one try. It never throws for what
// it could not remove: it gives back each thing left with its reason.

import { readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

const CHANGED = "changed while being removed";
const HOLDS = "holds something that was left";
const isGone = (err) => err.code === "ENOENT" || err.code === "ENOTDIR";

// A folder's entries with their types, or undefined when it is gone or is not a folder.
async function listing(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isGone(err)) return undefined;
    throw err;
  }
}

// The type `name` has in `holder`'s listing: "folder", "link", "file", or "gone" when it is not listed.
async function typeIn(holder, name) {
  const e = (await listing(holder))?.find((x) => x.name === name);
  if (!e) return "gone";
  if (e.isSymbolicLink()) return "link";
  return e.isDirectory() ? "folder" : "file";
}

// Removes a link itself: unlink, or rmdir where Windows refuses unlink on a directory link (a junction naming its
// drive by ID is one). Neither follows the link.
async function removeLink(p) {
  try {
    await unlink(p);
  } catch (err) {
    if (err.code !== "EPERM" && err.code !== "EISDIR") throw err;
    await rmdir(p);
  }
}

// Gives back what is left after the removal of `root`: [] when it is all gone, or was never there.
export async function tryRemoveTree(root, { pause, limit, seam }) {
  const top = path.resolve(root);
  const changed = new Set();
  const began = Date.now();
  for (;;) {
    const left = [];
    let refused = false;
    const keep = (p, reason) => void left.push({ path: p, reason });
    // Runs one deletion; false, with the path kept, when it was refused. Something already gone is not refused.
    const tried = async (p, run) => {
      try {
        await run();
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return true;
        refused = true;
        keep(p, `could not be removed: ${err.code ?? String(err)}`);
        return false;
      }
    };
    const change = (dir) => (changed.add(dir), keep(dir, CHANGED), false);

    // Removes the folder `name` in `holder`, which listed it as a folder; true when it is gone.
    const folder = async (holder, name) => {
      const dir = path.join(holder, name);
      if (changed.has(dir)) return keep(dir, CHANGED), false;
      await seam?.("before its own listing", dir);
      let entries;
      if (!(await tried(dir, async () => (entries = await listing(dir))))) return false;
      if (entries === undefined) return change(dir);
      await seam?.("before the second look", dir);
      let now;
      if (!(await tried(dir, async () => (now = await typeIn(holder, name))))) return false;
      if (now !== "folder") return change(dir);
      let whole = true;
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (changed.has(p)) whole = (keep(p, CHANGED), false);
        else if (e.isSymbolicLink()) whole = (await tried(p, () => removeLink(p))) && whole;
        else if (e.isDirectory()) whole = (await folder(dir, e.name)) && whole;
        else whole = (await tried(p, () => unlink(p))) && whole;
      }
      if (!whole) return keep(dir, HOLDS), false;
      return tried(dir, () => rmdir(dir));
    };

    let type;
    if (await tried(top, async () => (type = await typeIn(path.dirname(top), path.basename(top))))) {
      if (type === "gone") return [];
      if (type === "file") return [{ path: top, reason: "not a folder" }];
      if (type === "link") await tried(top, () => removeLink(top));
      else await folder(path.dirname(top), path.basename(top));
    }
    if (!refused || Date.now() - began >= limit) return left;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}
