// The protected paths (release 7 design, "Protected paths"; plan, Task 6 and choices 10, 57 and 59): Claude Code's
// list, plus .tachikoma. Other programs run these or read them as settings, so a write to one asks, or is refused in
// `never` (Task 8). A name counts at any depth in the project: a folder's as any one part of the path, a file's as its
// last part (choice 10), each part as the file system reads it: ignoring case on Windows and macOS, and on Windows the
// dots and spaces at a name's end and a ":stream" after it (choice 60). So `web/.husky/pre-commit`, `tools/.npmrc` and,
// on Windows, `tools/.npmrc.` are protected. A folder's name in the project's own path counts too (choice 62).
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
// links), as resolveIn found it, and it is compared with the project's real place, at least as widely as resolveIn
// compares them; so a path outside the project gives undefined, whatever `hooks` and `files` hold. A folder's name
// counts in the project's own folders too, so a project that is a protected folder or inside one (`~/.claude`, a
// repository's `.git`) protects every write in it, with that folder's path as the part (choice 62); a file's name
// counts only as the path's last part, which the project's folder never is. `hooks` are Task 5's hooksPaths and gitDirs
// (choice 59): a path in one gives the folder. `files` are Task 5's git settings files (choice 57): a path that is one
// gives that file. Every comparison is of the path's root (a drive, a share or /), ignoring case where names do, and
// then part by part, each part as the file system reads it (choice 60). `platform` is the system's, which a test gives
// as another's, with that system's path rules, as inData does.
export function protectedPart(
  root: string,
  real: string,
  hooks: string[],
  files: string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const { join, parse, resolve, sep } = platform === "win32" ? path.win32 : path.posix;
  const same = (a: string, b: string) => fold(a, platform) === fold(b, platform);
  // A path's root, as spelled (`spelt`) and as compared (`top`), and its parts after it. The root is not folded as a
  // part is, as a drive's `C:` would become `c`, a server's name in a network path.
  const split = (p: string): Split => {
    const whole = resolve(p);
    const spelt = parse(whole).root;
    const top = platform === "win32" || platform === "darwin" ? spelt.toLowerCase() : spelt;
    return { spelt, top, parts: whole.slice(spelt.length).split(sep).filter(Boolean) };
  };
  // Whether `p` is `folder`, or inside it; and whether it is `file`.
  const under = (folder: Split, p: Split) => folder.top === p.top && folder.parts.length <= p.parts.length && folder.parts.every((part, i) => same(part, p.parts[i]!));
  const is = (file: Split, p: Split) => file.parts.length === p.parts.length && under(file, p);
  const at = split(real);
  const base = split(realPath(root) ?? root);
  if (!under(base, at)) return undefined;
  for (const folder of PROTECTED_FOLDERS) {
    const names = folder.split("/");
    for (let i = 0; i + names.length <= at.parts.length; i++) {
      if (!names.every((name, j) => same(at.parts[i + j]!, name))) continue;
      const end = i + names.length;
      // One that starts in the project's own folders is named by its whole path.
      return i < base.parts.length ? join(at.spelt, ...at.parts.slice(0, end)) : join(...at.parts.slice(i, end));
    }
  }
  const last = at.parts.length > base.parts.length ? at.parts.at(-1) : undefined;
  if (last !== undefined && PROTECTED_FILES.some((name) => isFile(last, name, platform))) return last;
  return hooks.find((folder) => under(split(folder), at)) ?? files.find((file) => is(split(file), at));
}

type Split = { spelt: string; top: string; parts: string[] };

// Whether a path's last part is a protected file's name. A name ending in `.*` is matched by its start and a dot, after
// which anything may follow.
function isFile(part: string, name: string, platform: NodeJS.Platform): boolean {
  if (name.endsWith(".*")) return fold(part, platform).startsWith(`${fold(name.slice(0, -2), platform)}.`);
  return fold(part, platform) === fold(name, platform);
}

// A path part as the file system reads it (choice 60). Windows drops the dots and spaces at a name's end and a
// ":stream" after it, so `.npmrc.` and `.npmrc:x` write `.npmrc`, and ignores case; macOS ignores case too (as
// settingsName and sameIgnoringCase in tools/files.ts do; a copy, since that file will import this one in Task 8).
// Copy mode reads `.git` and `.tachikoma` with it too (sandbox/snapshot.ts), so what it leaves out is what apply refuses.
export function fold(part: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return part.replace(/:.*/s, "").replace(/[. ]+$/, "").toLowerCase();
  return platform === "darwin" ? part.toLowerCase() : part;
}

// A path's real place, or undefined when it cannot be told; `native` gives the long name for a short (8.3) one.
function realPath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}
