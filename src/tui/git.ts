import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// The project's git branch, read from the repository's HEAD file. No git program is run: in
// `project` mode the model can change .git/config without asking, and settings there name programs
// that `git status` runs, which would get round the approval shell commands need. So there is no mark
// for uncommitted changes (the user's choice, 2026-10-25). Null outside a repository, or when HEAD
// cannot be read.
export function gitBranch(root: string): string | null {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const st = statSync(dotGit, { throwIfNoEntry: false });
    if (st) {
      try {
        // A worktree's or submodule's .git is a file naming the repository: "gitdir: <path>".
        const gitDir = st.isDirectory() ? dotGit : path.resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir: /, "").trim());
        const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        // A commit checked out with no branch is "HEAD", as `git rev-parse --abbrev-ref HEAD` says.
        return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "HEAD";
      } catch {
        return null;
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}
