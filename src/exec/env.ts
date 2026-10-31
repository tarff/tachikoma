import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

// The API keys Tachikoma reads. Commands never see them, so one cannot print a key back to the model
// (release 2 design, "Hardening for every provider"). A command that needs one of these keys does not
// get it either.
export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "MOONSHOT_API_KEY"];

// Windows treats variable names without regard to case, so `openai_api_key` is the same variable.
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !API_KEYS.includes(name.toUpperCase())));
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
  const value = Object.entries(env).find(([key]) => (windows ? key.toUpperCase() === "PATH" : key === "PATH"))?.[1] ?? "";
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
