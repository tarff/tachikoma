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
// beside its program, pwsh.exe, however it was installed (an installer, the Store, a zip, scoop). A folder's name is
// not enough: SQL Server's ...\Tools\PowerShell\Modules ends as 7's folder for the user's own modules does (the
// outside review of PR #11; the user's choice, "PowerShell 7's own folder").
const ps7Home = (dir: string) => path.isAbsolute(dir) && /[\\/]Modules[\\/]?$/i.test(dir) && runnable(path.join(path.dirname(dir), "pwsh.exe"), true);

// Windows treats variable names without regard to case, so `openai_api_key` is the same variable. On Windows, a
// PSModulePath showing PowerShell 7 is left out: started from tachi under PowerShell 7, Windows PowerShell took 7's
// modules first and could not load its own, so Get-Acl and the like were not found (the CI trial). Left out, Windows
// PowerShell builds its own default, as Microsoft's about_PSModulePath advises for a program started between the two
// ("Starting Windows PowerShell from PowerShell 7"). Any other value is passed on untouched (the user's choice,
// 2026-11-07: "Only under PowerShell 7").
export function commandEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const ps7 = (name: string, value: string | undefined) =>
    platform === "win32" && name.toUpperCase() === "PSMODULEPATH" && (value ?? "").split(";").some(ps7Home);
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
  // The last of two (Path and PATH on Windows), as `{ ...process.env, PATH: x }` means x.
  const value = Object.entries(env).findLast(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
  for (const entry of value.split(path.delimiter)) {
    // Windows' PATH may hold a folder in quotes; "\folder" and "C:folder" depend on the working folder's drive or folder.
    const dir = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!(windows ? /^([a-z]:[\\/]|\\\\)/i.test(dir) : dir.startsWith("/"))) continue;
    const file = path.join(dir, windows ? `${name}.exe` : name);
    if (runnable(file, windows)) return file;
  }
  return undefined;
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
