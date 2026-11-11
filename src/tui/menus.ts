import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Prompt } from "@modelcontextprotocol/client";
import { visible } from "../core/permissions.js";
import { errorText } from "../core/types.js";
import type { Servers } from "../mcp/servers.js";
import { resolveIn } from "../tools/files.js";
import { EXPORT_WORDS, SESSION_WORDS, SHORTEN_WORDS } from "./app/constants.js";

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
  { label: "/lead <provider:model>", run: "/lead", note: "Switch the lead model; alone, pick it from a list" },
  { label: "/model", run: "/model", note: "Pick the lead model from a list" },
  { label: "/login chatgpt", run: "/login chatgpt", note: "Sign in to ChatGPT" },
  { label: "/logout chatgpt", run: "/logout chatgpt", note: "Sign out of ChatGPT" },
  { label: "/clear", run: "/clear", note: SESSION_WORDS.clear },
  { label: "/resume", run: "/resume", note: SESSION_WORDS.resume },
  { label: "/branch [name]", run: "/branch", note: SESSION_WORDS.branch },
  { label: "/rename <name>", run: "/rename", note: SESSION_WORDS.rename },
  { label: "/export [file]", run: "/export", note: EXPORT_WORDS.note },
  { label: "/compact [words]", run: "/compact", note: SHORTEN_WORDS.compact },
  { label: "/autocompact <tokens>", run: "/autocompact", note: SHORTEN_WORDS.autocompact },
  { label: "/tasks", run: "/tasks", note: "List the subagents; /tasks t1 shows one, /tasks stop stops them" },
  { label: "/hooks", run: "/hooks", note: "List the hooks in force" }, // the user's words, 2026-11-10 (release 8b plan, Task 12)
  { label: "/mcp", run: "/mcp", note: "List the MCP servers" }, // release 8c plan, "Lines this plan adds"
  { label: "/errors", run: "/errors", note: "Summarise the error log" },
  { label: "/screen", run: "/screen", note: "Switch between full screen and classic" },
  { label: "/settings", run: "/settings", note: "Open the settings file in your editor" },
  { label: "/keybindings", run: "/keybindings", note: "Open the keys file in your editor" },
  { label: "/vim", run: "/vim", note: "Switch vim mode on or off in this window" },
  { label: "/exit", run: "/exit", note: "Quit" },
];

// What the ready MCP servers offer the prompt (release 8c plan, Task 13): each resource as `<name>:<uri>`, which `@`
// lists, and each prompt as the command `/<name>:<prompt>`, in the servers' order and each list's. One whose name or uri
// holds a blank or a character visible() escapes is left out, as it could be neither typed nor read back from the prompt
// as one word.
export interface Offers {
  resources: { server: string; uri: string; key: string }[];
  prompts: { server: string; prompt: Prompt; command: string }[];
}
export function offers(servers: Pick<Servers, "list" | "server"> | undefined): Offers {
  const plain = (s: string) => !/\s/.test(s) && visible(s) === s;
  const o: Offers = { resources: [], prompts: [] };
  for (const { name } of servers?.list() ?? []) {
    const server = servers!.server(name);
    for (const r of server?.resources ?? []) if (plain(`${name}:${r.uri}`)) o.resources.push({ server: name, uri: r.uri, key: `${name}:${r.uri}` });
    for (const p of server?.prompts ?? []) if (plain(`/${name}:${p.name}`)) o.prompts.push({ server: name, prompt: p, command: `/${name}:${p.name}` });
  }
  return o;
}

// A slash at the start of the prompt and the word after it, with the cursor at the end: commands
// count only there, so "/tmp is full" is a message. The MCP servers' prompts follow Tachikoma's commands, each with the
// first line of its description, escaped, as the label is (Menu.tsx).
export function commandMenu(text: string, cursor: number, prompts: Offers["prompts"] = []): Menu | null {
  if (cursor !== text.length || !/^\/\S*$/.test(text)) return null;
  const typed = text.toLowerCase();
  const entries: Entry[] = COMMANDS.filter((c) => c.run.startsWith(typed)).map((c) => ({ label: c.label, note: c.note, fill: `${c.run.split(" ")[0]} `, run: c.run }));
  for (const p of prompts) {
    if (!p.command.toLowerCase().startsWith(typed)) continue;
    const note = p.prompt.description?.split(/\r?\n/)[0];
    entries.push({ label: p.command, ...(note && { note: visible(note) }), fill: `${p.command} `, run: p.command });
  }
  return entries.length ? { kind: "command", from: 0, entries } : null;
}

export type Listing = { entries: { name: string; folder: boolean }[] } | { error: string };

// `@` at the start or after a space, then a path, up to the cursor: the folder typed so far (the
// project folder for none) listed, narrowed by the name after it, in any case. A folder goes in with
// its "/", so the next Tab lists it; a file is completed with a space after it. The MCP servers' resources follow the
// files, as `@<name>:<uri>`, those whose `<name>:<uri>` starts with what is typed, in any case (release 8c plan, Task
// 13), completed as a file is. A uri's slashes make the folder typed so far one that cannot be listed, so the listing's
// error is left out while a resource matches.
export function pathMenu(text: string, cursor: number, list: (folder: string) => Listing, resources: Offers["resources"] = []): Menu | null {
  const m = /(?:^|\s)@(\S*)$/.exec(text.slice(0, cursor));
  if (!m || /\S/.test(text[cursor] ?? "")) return null;
  const typed = m[1]!;
  const cut = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\")) + 1;
  const folder = typed.slice(0, cut);
  const part = typed.slice(cut).toLowerCase();
  const from = cursor - typed.length - 1;
  const listing = list(folder);
  const served = resources.filter((r) => r.key.toLowerCase().startsWith(typed.toLowerCase())).map((r) => ({ label: `@${r.key}`, fill: `@${r.key} ` }));
  if ("error" in listing && !served.length) return { kind: "path", from, entries: [{ label: `Cannot list ${folder || "the project folder"}: ${listing.error}`, fill: "", error: true }] };
  const files = "error" in listing ? [] : listing.entries
    .filter((e) => e.name.toLowerCase().startsWith(part))
    .map((e) => ({ label: `${folder}${e.name}${e.folder ? "/" : ""}`, fill: `@${folder}${e.name}${e.folder ? "/" : " "}` }));
  const entries = [...files, ...served];
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
