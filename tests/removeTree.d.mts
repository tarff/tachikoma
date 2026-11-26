// Types for tests/removeTree.mjs, the tests' remover (cleanup plan, step 4); what it does and does not hold is in that
// file's first comment.

// The two moments the seam is called at, for each folder: after its holder was listed and before its own listing is
// read; and after its own listing is read and before the second look.
export type Moment = "before its own listing" | "before the second look";

// Something the removal left, and why: "changed while being removed", "holds something that was left", "not a folder"
// (a root that is a file), or "could not be removed: <code>" (refused on the last try).
export interface Left {
  path: string;
  reason: string;
}

// Removes `root` and gives back what is left: [] when it is all gone, or was never there. A refused try is made again
// after `pause` ms until `limit` ms have passed; `seam` is for tests of the remover only. `listedAsFolder`: the caller
// read from the holder's listing that the root is a folder, so the holder is not listed again (its limit is in
// removeTree.mjs's first comment).
export function tryRemoveTree(
  root: string,
  options: {
    pause: number;
    limit: number;
    seam?: (moment: Moment, folder: string) => void | Promise<void>;
    listedAsFolder?: boolean;
  },
): Promise<Left[]>;
