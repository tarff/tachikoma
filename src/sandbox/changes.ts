// Copy mode's changes (release 7 plan, Task 18; main design, "Applying a copy-then-review session" and "Links"; choices
// 25, 26 and 109): work/, as the box left it, compared with the snapshot's manifest. No link is followed: each is read
// as a link, on every system, Windows junctions included. The box has stopped by now (release 7 design, "Copy mode's
// review and apply run on the host only after the box has stopped"), so nothing in work/ changes while it is read.
import { lstat, open, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { BINARY_TEST_BYTES, ignored, type Rules, rulesIn } from "../tools/search.js";
import { isBinary } from "./diff.js";
import { hashFile, type Manifest, NOT_COPIED, reserved, unreadable } from "./snapshot.js";

// A file added, changed or deleted, which the review can apply, with its executable flag on each side it has; or a link
// added, retargeted or deleted, or a path whose type changed, which are shown only (choice 26), with the project's own
// link target or the type ("file", "folder", "link") on each side it has. `ignored`: git's ignore rules in the snapshot
// cover the path, so the review only counts it and apply never applies it (choice 109); such a file is never read, and
// its `binary` is false.
export type Change =
  | { kind: "added" | "changed" | "deleted"; path: string; binary: boolean; execBefore?: boolean; execAfter?: boolean; ignored: boolean }
  | { kind: "link" | "type"; path: string; before?: string; after?: string; ignored: boolean };

// `leftOut`: what work/ holds that is never applied, each with its why, for the review to show.
export interface Changes { changes: Change[]; leftOut: { path: string; why: string }[] }

const windows = process.platform === "win32";

// Why every `.git` and `.tachikoma` in work/, at any depth and compared as the snapshot compares them, is left out: Task
// 19's why for the same paths. The box's own repository, made in work/ at launch (choice 24), is one of them, and is
// listed too.
const NEVER_APPLIED = "Tachikoma's own and git's folders are never applied";

type Kind = "file" | "folder" | "link";

// work/ compared with `manifest`, sorted by path. base/ is beside work/ (choice 23).
export async function changes(manifest: Manifest, work: string): Promise<Changes> {
  const base = path.join(path.dirname(work), "base");
  const at = (copy: string, rel: string) => path.join(copy, ...rel.split("/"));
  const isIgnored = ignoredIn(base, manifest);
  const found: Change[] = [];
  const leftOut: Changes["leftOut"] = [];
  const seen = new Set<string>();
  const retyped = new Set<string>(); // nothing under a path whose type changed is listed: it is applied by hand, whole

  const walk = async (rel: string): Promise<void> => {
    for (const d of await readdir(at(work, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (reserved(d.name)) {
        leftOut.push({ path: r, why: NEVER_APPLIED });
        continue;
      }
      const abs = at(work, r);
      // As the snapshot reads an entry: Windows lists every reparse point as a link, and only one with a target is. One
      // that lstat cannot read either is a box's socket or pipe (snapshot.ts, unreadable).
      const target = d.isSymbolicLink() ? await readlink(abs).catch(() => undefined) : undefined;
      const kind = d.isSymbolicLink() && target === undefined ? await lstat(abs).catch(unreadable) : d;
      const now: Kind | undefined = target !== undefined ? "link" : kind?.isDirectory() ? "folder" : kind?.isFile() ? "file" : undefined;
      if (now === undefined) {
        // Not copied, so never applied; whatever the snapshot had here counts as deleted.
        leftOut.push({ path: r, why: NOT_COPIED });
        continue;
      }
      seen.add(r);
      // Its own entries only: a file named `constructor` is not the object's.
      const was = Object.hasOwn(manifest.entries, r) ? manifest.entries[r] : undefined;
      if (was && was.type !== now) {
        retyped.add(r);
        found.push({ kind: "type", path: r, before: was.type, after: now, ignored: await isIgnored(r, now === "folder") });
      } else if (now === "folder") await walk(r);
      else if (now === "link") {
        // Compared with the text work/ held after the snapshot, as a rewritten link must not show as changed; the
        // project's own target is the one shown (Task 17's quality review).
        if (was?.type !== "link") found.push({ kind: "link", path: r, after: target, ignored: await isIgnored(r, false) });
        else if (was.inCopy !== target) found.push({ kind: "link", path: r, before: was.target, after: target, ignored: await isIgnored(r, false) });
      } else {
        // A file by its entry, so hashFile, which follows links, reads the file itself. The executable flag is the
        // owner's bit, as the snapshot records it (git's ce_permissions); Windows has none.
        const st = await lstat(abs);
        const exec = !windows && (st.mode & 0o100) !== 0;
        const ignored = await isIgnored(r, false);
        if (was?.type !== "file") found.push({ kind: "added", path: r, binary: !ignored && (await binaryAt(abs)), execAfter: exec, ignored });
        // An ignored file is only counted, never applied, so its size and modified time stand for its content, as the
        // copy had them after the snapshot (choice 112); a box that sets both back hides a change from the count only.
        // One that can be applied is read in full.
        else if (was.exec !== exec || (ignored ? st.size !== was.size || st.mtimeMs !== was.mtimeMs : was.sha256 !== (await hashFile(abs)))) {
          const binary = !ignored && ((await binaryAt(at(base, r))) || (await binaryAt(abs)));
          found.push({ kind: "changed", path: r, binary, execBefore: was.exec, execAfter: exec, ignored });
        }
      }
    }
  };
  await walk("");

  // What the snapshot had that work/ no longer does. A folder's files are each listed; the folder itself is not, as git
  // keeps no folders.
  const underRetyped = (r: string) => {
    for (let i = r.indexOf("/"); i !== -1; i = r.indexOf("/", i + 1)) if (retyped.has(r.slice(0, i))) return true;
    return false;
  };
  for (const [r, was] of Object.entries(manifest.entries)) {
    if (seen.has(r) || was.type === "folder" || underRetyped(r)) continue;
    if (was.type === "link") found.push({ kind: "link", path: r, before: was.target, ignored: await isIgnored(r, false) });
    else {
      const ignored = await isIgnored(r, false);
      found.push({ kind: "deleted", path: r, binary: !ignored && (await binaryAt(at(base, r))), execBefore: was.exec, ignored });
    }
  }

  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { changes: found.sort(byPath), leftOut: leftOut.sort(byPath) };
}

// Whether git's ignore rules cover a path, by the .gitignore files of base/, the snapshot, so the box cannot change
// what is applied by editing one in work/ (choice 109), read as the search tools read them (search.ts). As in git, a
// folder the rules leave out leaves out all it holds, which no "!" below brings back. Only folders the manifest records
// as folders are read for rules; base/ was made by the snapshot, with no link but those the manifest records, so no
// link is followed. A path whose folders are new in work/ is judged by the rules of the deepest one base/ has.
function ignoredIn(base: string, manifest: Manifest): (rel: string, folder: boolean) => Promise<boolean> {
  const at = (rel: string) => path.join(base, ...rel.split("/"));
  const parent = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
  const folders = new Map<string, Promise<{ rules: Rules; out: boolean }>>();
  const folder = (rel: string) => {
    let state = folders.get(rel);
    if (!state) folders.set(rel, (state = read(rel)));
    return state;
  };
  const read = async (rel: string): Promise<{ rules: Rules; out: boolean }> => {
    if (rel === "") return { rules: await rulesIn(base), out: false };
    const up = await folder(parent(rel));
    const out = up.out || ignored(up.rules, at(rel), true);
    const own = !out && manifest.entries[rel]?.type === "folder" ? await rulesIn(at(rel)) : [];
    return { rules: [...up.rules, ...own], out };
  };
  return async (rel, isFolder) => {
    const up = await folder(parent(rel));
    return up.out || ignored(up.rules, at(rel), isFolder);
  };
}

// Whether a file reads as binary, by its first bytes (diff.ts). Never read for an ignored file, which the review only
// counts and never shows (choice 109), so `binary` is false there.
async function binaryAt(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(BINARY_TEST_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_TEST_BYTES, 0);
    return isBinary(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
