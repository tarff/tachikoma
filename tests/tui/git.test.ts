import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitBranch } from "../../src/tui/git.js";

// A folder with a repository's HEAD file, holding `head`.
function repo(head: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
  mkdirSync(path.join(root, ".git"));
  writeFileSync(path.join(root, ".git", "HEAD"), head);
  return root;
}

describe("gitBranch", () => {
  it("reads the branch from the repository's HEAD file, from the project folder or one inside it", () => {
    const root = repo("ref: refs/heads/feature/x\n");
    expect(gitBranch(root)).toBe("feature/x");
    mkdirSync(path.join(root, "src"));
    expect(gitBranch(path.join(root, "src"))).toBe("feature/x");
  });

  it("says HEAD when no branch is checked out, as git does", () => {
    expect(gitBranch(repo("0123456789abcdef0123456789abcdef01234567\n"))).toBe("HEAD");
  });

  it("follows a .git file to the repository it names, as a worktree has", () => {
    const main = repo("ref: refs/heads/main\n");
    const worktree = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
    mkdirSync(path.join(main, ".git", "worktrees", "w"), { recursive: true });
    writeFileSync(path.join(main, ".git", "worktrees", "w", "HEAD"), "ref: refs/heads/side\n");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "w")}\n`);
    expect(gitBranch(worktree)).toBe("side");
  });

  it("gives nothing outside a repository, or when HEAD cannot be read", () => {
    expect(gitBranch(mkdtempSync(path.join(tmpdir(), "tachi-git-")))).toBeNull();
    const broken = mkdtempSync(path.join(tmpdir(), "tachi-git-"));
    mkdirSync(path.join(broken, ".git"));
    expect(gitBranch(broken)).toBeNull();
  });
});
