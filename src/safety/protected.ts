// The protected paths (release 7 design, "Protected paths"; plan, Task 6 and choices 10, 57 and 59): Claude Code's
// list, plus .tachikoma. Other programs run these or read them as settings, so a write to one asks, or is refused in
// `never` (Task 8). A name counts at any depth in the project: a folder's as any one part of the path, a file's as its
// last part, ignoring case on Windows (choice 10). So `web/.husky/pre-commit` and `tools/.npmrc` are protected.
import { realpathSync } from "node:fs";
import path from "node:path";

// `.config/git` is two parts in a row.
export const PROTECTED_FOLDERS: readonly string[] = [
  ".git", ".config/git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude", ".tachikoma",
];
// A name ending in `.*` is that name followed by any extension: lefthook's `lefthook-local.*`, read literally, the more
// protective reading (choice 10).
export const PROTECTED_FILES: readonly string[] = [
  // git
  ".gitconfig", ".gitmodules",
  // shell start-up files
  ".bashrc", ".bash_profile", ".bash_login", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".envrc",
  // package tools
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml",
  // Bazel
  ".bazelrc", ".bazelversion", ".bazeliskrc",
  // hooks
  ".pre-commit-config.yaml",
  "lefthook.yml", "lefthook.yaml", "lefthook.json", "lefthook.toml", ".lefthook.yml", ".lefthook.yaml", ".lefthook.json", ".lefthook.toml",
  "lefthook-local.*", ".lefthook-local.*",
  // build wrappers
  "gradle-wrapper.properties", "maven-wrapper.properties",
  // others
  ".devcontainer.json", ".ripgreprc", "pyrightconfig.json", ".mcp.json", ".claude.json",
];

// The part of `real` that is protected, as the path spells it, or undefined. `real` is the path's real place (after
// links), as resolveIn found it, and it is compared with the project's real place, as resolveIn compares them; so a
// path outside the project gives undefined, whatever `hooks` and `files` hold. `hooks` are Task 5's hooksPaths and
// gitDirs (choice 59): a path in one gives the folder. `files` are Task 5's git settings files (choice 57): a path that
// is one gives that file.
export function protectedPart(root: string, real: string, hooks: string[], files: string[]): string | undefined {
  const base = realPath(root) ?? path.resolve(root);
  if (!within(base, real)) return undefined;
  const parts = path.relative(base, real).split(path.sep);
  for (const folder of PROTECTED_FOLDERS) {
    const names = folder.split("/");
    for (let i = 0; i + names.length <= parts.length; i++) {
      if (names.every((name, j) => sameName(parts[i + j]!, name))) return path.join(...parts.slice(i, i + names.length));
    }
  }
  const last = parts.at(-1)!;
  if (PROTECTED_FILES.some((name) => isFile(last, name))) return last;
  return hooks.find((folder) => within(folder, real)) ?? files.find((file) => path.relative(file, real) === "");
}

const fold = (name: string) => (process.platform === "win32" ? name.toLowerCase() : name);
const sameName = (a: string, b: string) => fold(a) === fold(b);
// A name ending in `.*` is matched by its start, up to and including the dot.
const isFile = (part: string, name: string) => (name.endsWith(".*") ? fold(part).startsWith(fold(name.slice(0, -1))) : sameName(part, name));

// A path's real place, or undefined when it cannot be told; `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

// Whether `p` is `folder` or inside it (path.relative compares without case on Windows). A name that only starts with
// two dots, such as `..bare`, is inside.
function within(folder: string, p: string): boolean {
  const rel = path.relative(folder, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
