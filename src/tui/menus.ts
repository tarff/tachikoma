import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { errorText } from "../core/types.js";
import { resolveIn } from "../tools/files.js";

// The `/` and `@` menus (release 3 design, "Menus and modes"), worked out from the prompt's text: what
// each entry shows, what Tab (and, for a path, Enter) puts in the prompt in place of the text from
// `from` to the cursor, and what Enter runs.

export interface Entry {
  label: string;
  note?: string; // what a command does
  fill: string;
  run?: string;
  error?: true; // a folder that could not be listed: shown, never filled
}

export interface Menu {
  kind: "command" | "path";
  from: number;
  entries: Entry[];
}

// The commands, as the README lists them, with what each does.
const COMMANDS: { label: string; run: string; note: string }[] = [
  { label: "/lead <provider:model>", run: "/lead", note: "Switch the lead model" },
  { label: "/model", run: "/model", note: "Pick the lead model from a list" },
  { label: "/login chatgpt", run: "/login chatgpt", note: "Sign in to ChatGPT" },
  { label: "/logout chatgpt", run: "/logout chatgpt", note: "Sign out of ChatGPT" },
  { label: "/tasks", run: "/tasks", note: "List the subagents; /tasks t1 shows one, /tasks stop stops them" },
  { label: "/errors", run: "/errors", note: "Summarise the error log" },
  { label: "/screen", run: "/screen", note: "Switch between full screen and classic" },
  { label: "/settings", run: "/settings", note: "Open the settings file in your editor" },
  { label: "/keybindings", run: "/keybindings", note: "Open the keys file in your editor" },
  { label: "/vim", run: "/vim", note: "Switch vim mode on or off in this window" },
  { label: "/exit", run: "/exit", note: "Quit" },
];

// A slash at the start of the prompt and the word after it, with the cursor at the end: commands
// count only there, so "/tmp is full" is a message.
export function commandMenu(text: string, cursor: number): Menu | null {
  if (cursor !== text.length || !/^\/\S*$/.test(text)) return null;
  const typed = text.toLowerCase();
  const entries = COMMANDS.filter((c) => c.run.startsWith(typed)).map((c) => ({ label: c.label, note: c.note, fill: `${c.run.split(" ")[0]} `, run: c.run }));
  return entries.length ? { kind: "command", from: 0, entries } : null;
}

export type Listing = { entries: { name: string; folder: boolean }[] } | { error: string };

// `@` at the start or after a space, then a path, up to the cursor: the folder typed so far (the
// project folder for none) listed, narrowed by the name after it, in any case. A folder goes in with
// its "/", so the next Tab lists it; a file is completed with a space after it.
export function pathMenu(text: string, cursor: number, list: (folder: string) => Listing): Menu | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cursor));
  if (!m || /\S/.test(text[cursor] ?? "")) return null;
  const typed = m[1]!;
  const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\")) + 1;
  const folder = typed.slice(0, cut);
  const part = typed.slice(cut).toLowerCase();
  const from = cursor - typed.length - 1;
  const listing = list(folder);
  if ("error" in listing) return { kind: "path", from, entries: [{ label: `Cannot list ${folder || "the project folder"}: ${listing.error}`, fill: "", error: true }] };
  const entries = listing.entries
    .filter((e) => e.name.toLowerCase().startsWith(part))
    .map((e) => ({ label: `${folder}${e.name}${e.folder ? "/" : ""}`, fill: `@${folder}${e.name}${e.folder ? "/" : " "}` }));
  return entries.length ? { kind: "path", from, entries } : null;
}

// A folder of the project, or one a path leads to: folders first, then files, each by name. What the
// file tools refuse (Tachikoma's data folder, its settings files, a program's environment) is left out,
// by the same check.
export function listFolder(root: string, folder: string): Listing {
  try {
    const dir = resolveIn(root, folder || ".").abs;
    const entries = readdirSync(dir).flatMap((name) => {
      const abs = path.join(dir, name);
      try {
        resolveIn(root, abs);
      } catch {
        return [];
      }
      return [{ name, folder: statSync(abs, { throwIfNoEntry: false })?.isDirectory() === true }];
    });
    return { entries: entries.sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name)) };
  } catch (err) {
    return { error: errorText(err) };
  }
}
