import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { lastSaved, type Loaded, readSettings, SETTINGS, settingsDir } from "./settings.js";

// What the watcher makes of the file's text each time it reads it (null: there is no file), in order: the settings
// to apply, a problem to report, or null for no change (release 6 plan, Task 9). Tachikoma's own last save is
// passed over once (settings.ts, lastSaved), so the same text written later by hand still counts; an edit that lands
// just before a save is read into the save's text, and so is passed over with it, a small risk the plan accepts. An
// empty file is skipped, as editors such as Notepad empty the file before writing it (choice 3); a removed one is {}
// (release 6 design, "Live edits"). A broken file is reported once for the same broken text, so an editor's empty
// write between two saves of it says nothing more. Apart from the watching, so the rule can be checked text by text.
export function changes(file: string, start: string | null): (text: string | null) => Loaded | null {
  let last = start;
  let reported: string | null = null;
  return (text) => {
    if (text !== null && text === lastSaved.get(file)) {
      lastSaved.delete(file);
      last = text;
      return null;
    }
    if (text === last) return null;
    last = text;
    if (text === "") return null;
    const read = text === null ? { settings: {}, warnings: [] } : readSettings(text);
    if (!("problem" in read)) reported = null;
    else if (text === reported) return null;
    else reported = text;
    return read;
  };
}

// Watches ~/.tachikoma, made first with a plain mkdir if it is missing, so a first session has a folder to watch
// (choice 16), and calls back with each real change to the settings file in it. The file is read again on every
// event in the folder, as a save also makes and removes a lock, a pid and a temporary file there (settings.ts,
// saveSetting), and only a change of its text counts. Once the folder itself is removed, its file applies as removed
// and the watch is closed, and `gone` is called: on Windows a watch on a removed folder reports the removal over and
// over until it is closed, about 35,000 events in 0.5 s (Node 24.22.1, measured 2026-10-28).
export function watchSettings(home: string, on: (next: Loaded) => void, gone: () => void): () => void {
  const dir = settingsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS);
  const step = changes(file, read(file) ?? null);
  let closed = false;
  const watcher = watch(dir, () => {
    if (closed) return;
    const text = read(file);
    if (text === undefined) return;
    const next = step(text);
    if (next) on(next);
    if (text !== null || existsSync(dir)) return;
    closed = true;
    watcher.close();
    gone();
  });
  return () => watcher.close();
}

// The file's text, null when there is none, or undefined when it cannot be read now: that event is passed over, and
// the next one in the folder reads it again.
function read(file: string): string | null | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}
