import { existsSync, type FSWatcher, mkdirSync, readFileSync, watch } from "node:fs";
import path from "node:path";
import { KEYBINDINGS, type KeysLoaded, readKeybindings } from "./keybindings.js";
import { emptyText, lastSaved, type Loaded, readSettings, SETTINGS, settingsDir } from "./settings.js";

// What the watcher makes of a file's text each time it reads it (null: there is no file), in order: what `parse` reads
// in it to apply, a problem to report, or null for no change (release 6 plan, Tasks 9 and 11: the settings file and the
// keys file alike). The first text read is always passed on, so an edit made between the launch's reading and the
// watch, during the instruction files' question say, still applies; the App applies only the entries that differ from
// the launch's. Tachikoma's own last save is passed over once (settings.ts, lastSaved), so the same text written later
// by hand still counts; an edit that lands just before a save is read into the save's text, and so is passed over with
// it, a small risk the plan accepts. An empty file, as the launch reads one (settings.ts, emptyText), is skipped, as
// editors such as Notepad empty the file before writing it (choice 3); a removed one is {} (release 6 design, "Live
// edits"), for both files here alone. A broken file is reported once for the same broken text, so an editor's empty
// write between two saves of it says nothing more. Apart from the watching, so the rule can be checked text by text.
export function changes<T extends object>(file: string, parse: (text: string) => T): (text: string | null) => T | null {
  let last: string | null | undefined; // undefined: nothing read yet, which no text matches
  let reported: string | null = null;
  return (text) => {
    if (text !== null && text === lastSaved.get(file)) {
      lastSaved.delete(file);
      last = text;
      return null;
    }
    if (text === last) return null;
    last = text;
    if (text !== null && emptyText(text)) return null;
    const read = parse(text ?? "{}");
    if (!("problem" in read)) reported = null;
    else if (text === reported) return null;
    else reported = text;
    return read;
  };
}

// Watches ~/.tachikoma, made first with a plain mkdir if it is missing, so a first session has a folder to watch
// (choice 16), and calls back with the settings file and the keys file as they are, then with each real change to
// either. Both files are read again on every event in the folder, as a save also makes and removes a lock, a pid and a
// temporary file there (settings.ts, saveSetting), and only a change of a file's text counts. Once the folder itself is
// removed, its files apply as removed, the watch is closed and `gone` is called: on Windows a watch on a removed folder
// reports the removal over and over until it is closed, about 35,000 events in 0.5 s (Node 24.22.1, measured
// 2026-10-28). An error from the watch ends it the same way: Node's fs.watch docs say that on Windows "an EPERM error
// is reported when the watched directory is deleted", and an error with no listener would end the session. Making the
// folder or starting the watch can throw (a home that cannot be written, Linux's limit on watches); the caller says
// so. A watch that cannot start still reads the files once, so their keys apply unwatched (choice 21).
export function watchSettings(home: string, on: (next: Loaded) => void, onKeys: (next: KeysLoaded) => void, gone: () => void): () => void {
  const dir = settingsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS);
  const keysFile = path.join(dir, KEYBINDINGS);
  const step = changes(file, readSettings);
  const keysStep = changes(keysFile, readKeybindings);
  let watcher: FSWatcher | undefined;
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    watcher?.close();
    gone();
  };
  const seen = () => {
    if (closed) return;
    const text = read(file);
    const keys = read(keysFile);
    const next = text === undefined ? null : step(text);
    if (next) on(next);
    const nextKeys = keys === undefined ? null : keysStep(keys);
    if (nextKeys) onKeys(nextKeys);
    if (text === null && keys === null && !existsSync(dir)) end();
  };
  try {
    watcher = watch(dir, seen);
  } catch (err) {
    seen();
    throw err;
  }
  watcher.on("error", end);
  try {
    seen();
  } catch (err) {
    watcher.close(); // the caller, told by the throw that nothing is watched, has no way to close it
    throw err;
  }
  return () => watcher?.close();
}

// A file's text, null when there is none, or undefined when it cannot be read now: that event is passed over for it,
// and the next one in the folder reads it again.
function read(file: string): string | null | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}
