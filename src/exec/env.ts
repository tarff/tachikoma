import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

// The API keys Tachikoma reads. Commands never see them, so one cannot print a key back to the model
// (release 2 design, "Hardening for every provider"). A command that needs one of these keys does not
// get it either.
export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "MOONSHOT_API_KEY"];

// The variables commands never see: the API keys, and CDPATH, as bash's cd looks in its folders first, so the user's own
// could send a command's `cd sub` out of the project, where the dangerous-command check, which takes `cd sub` as the
// project's `sub`, does not follow it (release 7 plan, Task 3's known limits; Task 8).
const DROPPED = [...API_KEYS, "CDPATH"];

// A sign of PowerShell 7 in PSModulePath: the Modules folder of its own install ($PSHOME), which it always lists,
// beside its program, pwsh.exe (an installer, the Store, a zip, scoop), or pwsh.dll (which the .NET global tool's
// folder may hold instead; not measured). A folder's name is not enough: SQL Server's ...\Tools\PowerShell\Modules ends
// as 7's folder for the user's own modules does (the outside review of PR #11; the user's choice, "PowerShell 7's own
// folder"). A path starting \\server\share (or the rare \\?\ form) is not looked at, as one that cannot be reached took
// 42 s (PR #11's review, measured) and PowerShell 7 is rarely installed there; a mapped drive letter still is, once.
const ps7Home = (dir: string) =>
  !/^[\\/]{2}/.test(dir) &&
  path.isAbsolute(dir) &&
  /[\\/]Modules[\\/]?$/i.test(dir) &&
  ["pwsh.exe", "pwsh.dll"].some((file) => runnable(path.join(path.dirname(dir), file), true));

// The last PSModulePath looked at, and whether it showed PowerShell 7, so each value costs its looks on disk once (the
// user's choice, "Remember + skip shares"): a command, a git run and a Docker call each take commandEnv.
let seen: { value: string; ps7: boolean } | undefined;

// Windows treats variable names without regard to case, so `openai_api_key` is the same variable. On Windows, a
// PSModulePath showing PowerShell 7 is left out: started from tachi under PowerShell 7, Windows PowerShell took 7's
// modules first and could not load its own, so Get-Acl and the like were not found (the CI trial). Left out, Windows
// PowerShell builds its own default, as Microsoft's about_PSModulePath advises for a program started between the two
// ("Starting Windows PowerShell from PowerShell 7"). Any other value is passed on untouched (the user's choice,
// 2026-11-07: "Only under PowerShell 7").
export function commandEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const ps7 = (name: string, value = "") => {
    if (platform !== "win32" || name.toUpperCase() !== "PSMODULEPATH") return false;
    if (seen?.value !== value) seen = { value, ps7: value.split(";").some(ps7Home) };
    return seen.ps7;
  };
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => !DROPPED.includes(name.toUpperCase()) && !ps7(name, value)));
}

// A Windows program by its full path, so a program of the same name earlier on PATH (Git Bash has its
// own whoami) is not run instead.
export const system32 = (exe: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);

// A program by its full path, from the first folder on `env`'s PATH that holds it, or undefined when none does. Started
// by its bare name, Windows would look in the working folder before PATH (review fixes plan, fix 1), so it is never
// started that way. Empty and relative entries are passed over, as they name the working folder too. Only `<name>.exe`
// is looked for on Windows: a .cmd or .bat would run through cmd.exe.
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const windows = process.platform === "win32";
  for (const dir of pathFolders(env, windows)) {
    const file = path.join(dir, windows ? `${name}.exe` : name);
    if (runnable(file, windows)) return file;
  }
  return undefined;
}

// A variable's value: on Windows, whatever the case of its name, the last of two (Path and PATH), as
// `{ ...process.env, PATH: x }` means x.
const variable = (env: NodeJS.ProcessEnv, name: string, windows: boolean) =>
  Object.entries(env).findLast(([key]) => (windows ? key.toUpperCase() === name : key === name))?.[1];

// PATH's folders that are written in full.
function pathFolders(env: NodeJS.ProcessEnv, windows: boolean): string[] {
  return (variable(env, "PATH", windows) ?? "").split(windows ? ";" : ":").flatMap((entry) => {
    // Windows' PATH may hold a folder in quotes; "\folder" and "C:folder" depend on the working folder's drive or folder.
    const dir = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    return (windows ? /^([a-z]:[\\/]|\\\\)/i.test(dir) : dir.startsWith("/")) ? [dir] : [];
  });
}

// The endings Windows itself adds to a program's name, in its own order, used when PATHEXT names none of them (release 8c
// plan, choice 4). Others PATHEXT may list, such as .vbs and .js, are left out, as choice 4 has it.
const ENDINGS = [".com", ".exe", ".bat", ".cmd"];

// An MCP server's program by its full path, or null when no PATH folder holds it (release 8c plan, choice 4). Unlike
// onPath, a .cmd or .bat counts, as npx is npx.cmd on Windows: each PATH folder is tried with each of PATHEXT's endings
// among ENDINGS, in its order, the first file found winning. A name already ending in one of them is looked for as
// written. As with onPath, the working folder is never looked in unless PATH names it in full. A command with a folder
// in it is used as written. Hooks keep onPath.
export function mcpProgram(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const windows = platform === "win32";
  if ((windows ? /[\\/]/ : /\//).test(command)) return command;
  const listed = (variable(env, "PATHEXT", windows) ?? "").split(";").map((e) => e.trim().toLowerCase()).filter((e) => ENDINGS.includes(e));
  // Lower case, as the files are usually named (npx.cmd), so the full path given matches the file's own name.
  const endings = !windows || ENDINGS.some((e) => command.toLowerCase().endsWith(e)) ? [""] : listed.length ? listed : ENDINGS;
  for (const dir of pathFolders(env, windows)) {
    for (const ending of endings) {
      const file = path.join(dir, `${command}${ending}`);
      if (runnable(file, windows)) return file;
    }
  }
  return null;
}

// Git Bash, where Claude Code looks for it, for hooks run by a shell on Windows (release 8b plan, choice 1): the file
// CLAUDE_CODE_GIT_BASH_PATH names, when it is called bash or sh, as Claude Code's rule has it; bin\bash.exe beside the
// folder of the first git.exe on PATH (...\Git\cmd\git.exe gives ...\Git\bin\bash.exe); then Git for Windows' two
// install folders. Never a bare `bash` from PATH, which on Windows can be WSL's, and never a relative path, which
// would name the working folder. Null when none is found, and on other systems, where it is not used. Looked up once
// for Tachikoma's own environment; a made-up one, a test's, is looked up each time.
let found: string | null | undefined;
export function gitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (env === process.env && platform === process.platform) return found === undefined ? (found = lookForGitBash(env, platform)) : found;
  return lookForGitBash(env, platform);
}

function lookForGitBash(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  const named = env.CLAUDE_CODE_GIT_BASH_PATH;
  const git = onPath("git", env);
  const candidates = [
    named && /^(bash|sh)(\.exe)?$/i.test(path.basename(named)) ? named : undefined,
    git && path.join(path.dirname(path.dirname(git)), "bin", "bash.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "Git", "bin", "bash.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
  ];
  return candidates.find((file) => file && path.isAbsolute(file) && runnable(file, true)) ?? null;
}

// A file that can be run: outside Windows its run bit must be set. Any failure (not found, no access, an entry that is a
// file) passes the entry over, as the system's own lookup does.
function runnable(file: string, windows: boolean): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!windows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
