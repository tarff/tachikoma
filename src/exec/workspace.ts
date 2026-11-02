// The project's files, for the file tools, search, the @ menu, the branch and pasted pictures (release 7 design,
// "Nothing on the host opens a path in the box's folder while the box runs"; plan, Task 13). LocalWorkspace (local.ts)
// is today's code on the host; BoxWorkspace (sandbox/boxWorkspace.ts) does each in the box, through the helper.

// What a folder holds, as the @ menu lists it: a link counts as what it leads to, and "link" is one that leads nowhere.
export interface Entry { name: string; type: "file" | "folder" | "link" | "other" }

// A matching line, its text cut as search_files cuts it.
export interface Match { file: string; line: number; text: string }

// `root` is "/work" in the box (choice 19). `real` is resolveIn's: unknown where a link leads nowhere or the place cannot
// be told. `search` gives the lines up to search_files' output cap and counts the rest in `beyond`.
export interface Workspace {
  root: string;
  resolve(p: string, opts?: { trusted?: boolean }): Promise<{ abs: string; outside: boolean; shown: string; real?: string }>;
  readText(abs: string): Promise<string>;
  readBytes(abs: string): Promise<Buffer>; // pasted pictures
  writeText(abs: string, content: string): Promise<void>;
  list(folder: string): Promise<Entry[]>;
  find(start: string, pattern: string, signal?: AbortSignal): Promise<string[]>;
  search(start: string, pattern: string, glob: string | undefined, signal?: AbortSignal): Promise<{ matches: Match[]; beyond: number }>;
  branch(): Promise<string | null>;
}

// The @ menu's order: folders first, then the rest, each by name.
export const entryOrder = (a: Entry, b: Entry) => Number(b.type === "folder") - Number(a.type === "folder") || a.name.localeCompare(b.name);
