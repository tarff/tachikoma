import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { writePrivate } from "../auth/private.js";
import type { MemoryPaths } from "./paths.js";

// "Don't ask again", the first-use question's third answer (8d plan, step 27; Q12): one small private file in
// <data folder>/memory/, for every project, as the palace is one for all of them. While it is there the launch does
// not ask; /memory setup clears it (step 28). It holds nothing: being there is the answer.
const file = (paths: MemoryPaths) => path.join(paths.root, "dont-ask");

export const dontAsk = (paths: MemoryPaths): boolean => existsSync(file(paths));

// Made with the memory folder, private, as writePrivate makes its folder.
export function recordDontAsk(paths: MemoryPaths): void {
  writePrivate(file(paths), "");
}

export function clearDontAsk(paths: MemoryPaths): void {
  rmSync(file(paths), { force: true });
}
