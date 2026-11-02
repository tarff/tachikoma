// The project's files, for the file tools, search and the branch (release 7 design, "Nothing on the host opens a path in
// the box's folder while the box runs"; plan, Tasks 13 and 14). The @ menu and pasted paths stay on the host (choices 98
// and 99). LocalWorkspace (local.ts) is today's code on the host; BoxWorkspace (sandbox/boxWorkspace.ts) does each in
// the box, through the helper.

// A matching line, its text cut as search_files cuts it.
export interface Match { file: string; line: number; text: string }

// `root` is "/work" in the box (choice 19). `real` is resolveIn's: unknown where a link leads nowhere or the place cannot
// be told. `search` gives the lines up to search_files' output cap and counts the rest in `beyond`.
export interface Workspace {
  root: string;
  resolve(p: string, opts?: { trusted?: boolean }): Promise<{ abs: string; outside: boolean; shown: string; real?: string }>;
  readText(abs: string): Promise<string>;
  writeText(abs: string, content: string): Promise<void>;
  find(start: string, pattern: string, signal?: AbortSignal): Promise<string[]>;
  search(start: string, pattern: string, glob: string | undefined, signal?: AbortSignal): Promise<{ matches: Match[]; beyond: number }>;
  branch(): Promise<string | null>;
}
