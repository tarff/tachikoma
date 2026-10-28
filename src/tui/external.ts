// The external editor (release 6 design, "The external editor"; release 6 plan, Task 12): Ctrl+G's prompt, and the
// settings and keys files for /settings and /keybindings. App runs both inside the terminal's owner (owner.ts,
// program), so an editor that runs in the terminal reads every key itself.
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorText } from "../core/types.js";
import { commandEnv, system32 } from "../exec/env.js";

// Starts the editor and says how it ended; a test passes its own.
export type Runner = (file: string, args: string[], options: SpawnOptions) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

const spawned: Runner = (file, args, options) =>
  new Promise((resolve, reject) => {
    spawn(file, args, options)
      .on("error", reject)
      .on("exit", (code, signal) => resolve({ code, signal }));
  });

// The reason given when the shell found no such command, which App words as "<command> was not found".
export const NOT_FOUND = "not found";
// The shell's exit for a command it cannot find: 9009 from cmd.exe, its ERRORLEVEL after "is not recognized as an
// internal or external command", which `& exit` makes its exit (runEditor, below); 127 from sh (POSIX Shell Command
// Language, 2.8.2 "Exit Status for Commands": "If a command is not found, the exit status shall be 127").
const NOT_FOUND_EXIT = process.platform === "win32" ? 9009 : 127;

// VISUAL, then EDITOR, then the settings file's "editor", then Notepad from System32 on Windows, or vi elsewhere (the
// user's choice, design). An empty one counts as unset.
export function editorCommand(env: NodeJS.ProcessEnv, setting: string | undefined, platform: NodeJS.Platform): string {
  return env.VISUAL || env.EDITOR || setting || (platform === "win32" ? system32("notepad.exe") : "vi");
}

// The prompt's text in a private temporary file (choice 5: prompt.md in a fresh folder, the user's own temporary
// folder on Windows, opened with mode 0o600), the editor run on it, and the text it saved, without the one line break
// editors add at the end (design, "On return"). The folder is removed after, unless the editor still holds it open
// (Windows), in which case it is left where only the user can read it.
export async function editText(text: string, command: string, run = spawned): Promise<{ text: string } | { failed: string }> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "tachi-editor-"));
    const file = path.join(dir, "prompt.md");
    await writeFile(file, text, { mode: 0o600, flag: "wx" });
    const failed = await runEditor(file, command, run);
    if (failed !== null) return { failed };
    return { text: (await readFile(file, "utf8")).replace(/\r?\n$/, "") };
  } catch (err) {
    return { failed: errorText(err) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// An existing file, opened where it is, so each save the editor makes reaches the settings watcher while it is still
// open (plan, Task 12).
export async function editFile(file: string, command: string, run = spawned): Promise<{ ok: true } | { failed: string }> {
  const failed = await runEditor(file, command, run);
  return failed === null ? { ok: true } : { failed };
}

// Choice 4: through the system's shell, as Git runs core.editor, so an entry with its own options (`code --wait`) and a
// .cmd on Windows work. On Windows: cmd.exe /d /s /c, /d leaving out its AutoRun commands, and /s taking off only the
// outer quotes, so the entry's own quotes and the file's stay; the line goes as written (windowsVerbatimArguments), as
// Node's own `shell` option passes it. `& exit` follows, so cmd exits with its ERRORLEVEL: alone, `cmd /c` exits 1 for
// a command it cannot find. Measured on Windows 11 build 26200, 2026-10-28: an unknown command gives 9009; node
// exiting 0, 1 or 3 and a .cmd editor exiting 0 or 5 pass through; a path in a missing folder gives 3 ("The system
// cannot find the path specified"). Elsewhere sh gets the file as $1, so no character in its path needs quoting. The
// terminal is the editor's (stdio inherited), and the environment is the one commands get, without the API keys. Null
// when it saved and exited with 0; otherwise the reason.
async function runEditor(file: string, command: string, run: Runner): Promise<string | null> {
  const options = { stdio: "inherit", env: commandEnv() } as const;
  try {
    const { code, signal } =
      process.platform === "win32"
        ? await run(system32("cmd.exe"), ["/d", "/s", "/c", `"${command} "${file}" & exit"`], { ...options, windowsVerbatimArguments: true })
        : await run("/bin/sh", ["-c", `${command} "$1"`, "sh", file], options);
    if (code === 0) return null;
    if (code === NOT_FOUND_EXIT) return NOT_FOUND;
    return code === null ? `stopped by ${signal}` : `exit code ${code}`;
  } catch (err) {
    return errorText(err);
  }
}
