import path from "node:path";
import { shellText } from "../tools/shell.js";

// Tachikoma's tools as hooks see them, in Claude Code's names, inputs and results, so a hook made for Claude Code works
// unchanged, and a hook's rewrite turned back into what the tool takes (release 8b design, "Tool hooks"; plan, Task 5).
// Nothing here runs a tool or a hook.

// How a path the tool takes becomes the one hooks are sent, and back (design, "Tool hooks"): on the host the real one;
// in live link the box's /work turned into the real project; in copy mode the box's, both ways. `fromHost` gives null for
// a host path outside the project that the box would take as a name in /work (the user's choice, 2026-11-09).
export interface Paths { toHost(p: string): string; fromHost(p: string): string | null }

// The box's folder for the project, as clilib.ts (BOX_ROOT) and mounts.ts (BOX) name it (release 7 plan, choice 19).
const BOX = "/work";

// Whether `rel`, from path.relative, leads out of the folder, by the given system's rules (files.ts's `leaves`, for any
// system, so a test can give Windows' on another).
const leaves = (rel: string, rules: path.PlatformPath) => rel === ".." || rel.startsWith(`..${rules.sep}`) || rules.isAbsolute(rel);

// `root` is the project's folder on the host as the launch found it; `box` the sandbox's mode, or null without one.
// `platform` is the system's, which a test gives as another's.
export function pathsFor(root: string, box: { mode: "live" | "copy" } | null, platform: NodeJS.Platform = process.platform): Paths {
  const host = platform === "win32" ? path.win32 : path.posix;
  if (!box) return { toHost: (p) => host.resolve(root, p), fromHost: (p) => p };
  const inBox = (p: string) => path.posix.resolve(BOX, p);
  // On Windows a whole path starting with one "/" can only be the box's, as Windows' own start with a drive or \\.
  const boxOwn = (p: string) => platform === "win32" && /^\/(?!\/)/.test(p);
  const outside = (p: string) => leaves(host.relative(root, p), host);
  const toBox = (p: string) => path.posix.join(BOX, ...host.relative(root, p).split(host.sep));
  // Copy mode: hooks are sent the box's paths, so off Windows a whole path is the box's too. On Windows the box would take
  // a host path (C:\..., \\server\...) as a name in /work, so one in the project becomes its place in the copy, the file
  // the tool works on, and one outside it is refused (the user's choices, 2026-11-09).
  if (box.mode === "copy") {
    return {
      toHost: inBox,
      fromHost: (p) => (platform !== "win32" || !host.isAbsolute(p) || boxOwn(p) ? p : outside(p) ? null : toBox(p)),
    };
  }
  return {
    // A box path outside /work, such as /etc/hosts, is the box's own and has no place on the host, so it stays.
    toHost(p) {
      const rel = path.posix.relative(BOX, inBox(p));
      return leaves(rel, path.posix) ? inBox(p) : host.join(root, ...rel.split("/"));
    },
    // Live link: hooks are sent host paths, so a whole one is the host's, and outside the project the box cannot reach it
    // (the user's choice, 2026-11-09). One not whole is left for the tool to take as it would the model's.
    fromHost(p) {
      if (!host.isAbsolute(p) || boxOwn(p)) return p;
      return outside(p) ? null : toBox(p);
    },
  };
}

type Kind = "text" | "path" | "count" | "flag" | "todos";
interface Field { ours: string; theirs: string; kind: Kind; required?: true }
// A field Claude Code's tool has and Tachikoma's has not (choice 14): taken only at Tachikoma's own way (`only`), never
// (`never`), or, for a label that changes nothing about the call, as any text, then left out.
type Extra = { only: unknown; as: string } | { never: string } | "label";
interface Spec { claude: string; fields: Field[]; sent?: Record<string, unknown>; extra?: Record<string, Extra> }

// The design's table ("Tool hooks"), with the fields of choice 14. Read's offset and limit are counted from 1, as both
// tools count them (files.ts, read_file).
const TOOLS: Record<string, Spec> = {
  shell: {
    claude: "Bash",
    fields: [{ ours: "command", theirs: "command", kind: "text", required: true }],
    extra: {
      description: "label",
      timeout: { never: "Tachikoma's shell has no time limit" },
      run_in_background: { only: false, as: "Tachikoma's shell cannot run a command in the background" },
    },
  },
  read_file: {
    claude: "Read",
    fields: [
      { ours: "path", theirs: "file_path", kind: "path", required: true },
      { ours: "offset", theirs: "offset", kind: "count" },
      { ours: "limit", theirs: "limit", kind: "count" },
    ],
  },
  write_file: {
    claude: "Write",
    fields: [
      { ours: "path", theirs: "file_path", kind: "path", required: true },
      { ours: "content", theirs: "content", kind: "text", required: true },
    ],
  },
  edit_file: {
    claude: "Edit",
    fields: [
      { ours: "path", theirs: "file_path", kind: "path", required: true },
      { ours: "old_text", theirs: "old_string", kind: "text", required: true },
      { ours: "new_text", theirs: "new_string", kind: "text", required: true },
    ],
    extra: { replace_all: { only: false, as: "Tachikoma's edit_file replaces one exact match" } },
  },
  find_files: {
    claude: "Glob",
    fields: [{ ours: "pattern", theirs: "pattern", kind: "text", required: true }],
    extra: { path: { never: "Tachikoma's find_files searches the whole project" } },
  },
  search_files: {
    claude: "Grep",
    fields: [
      { ours: "pattern", theirs: "pattern", kind: "text", required: true },
      { ours: "path", theirs: "path", kind: "path" },
      { ours: "glob", theirs: "glob", kind: "text" },
    ],
    extra: {
      output_mode: { only: "content", as: "Tachikoma's search_files gives the matching lines" },
      "-i": { only: false, as: "Tachikoma's search_files matches letter case exactly" },
      multiline: { only: false, as: "Tachikoma's search_files matches within one line" },
    },
  },
  delegate: {
    claude: "Agent",
    fields: [
      { ours: "description", theirs: "description", kind: "text", required: true },
      { ours: "task", theirs: "prompt", kind: "text", required: true },
      { ours: "background", theirs: "run_in_background", kind: "flag" },
    ],
    // Claude Code's name for its read-only subagent, as Tachikoma's subagents only read (design, "What a hook is sent").
    sent: { subagent_type: "Explore" },
    extra: {
      subagent_type: { only: "Explore", as: "Tachikoma's subagents only read" },
      model: { never: "a subagent runs on the model --worker names, or else the lead's" },
    },
  },
  todo: { claude: "TodoWrite", fields: [{ ours: "items", theirs: "todos", kind: "todos", required: true }] },
};

// The Tachikoma tool Claude Code's name stands for, or the name itself for a tool it does not know, for the lines, which
// name tools as the window does (choice 10).
export const tachikomaName = (claude: string) => Object.keys(TOOLS).find((name) => TOOLS[name]!.claude === claude) ?? claude;

// The to-do list's statuses: Tachikoma's `done` is Claude Code's `completed` (Task 5).
const TO_CLAUDE: Record<string, string> = { pending: "pending", in_progress: "in_progress", done: "completed" };
const FROM_CLAUDE: Record<string, string> = { pending: "pending", in_progress: "in_progress", completed: "done" };
// Claude Code's TodoWrite item has `activeForm`, the words shown while it is in progress: a label, as Bash's description.
const TODO_FIELDS = ["content", "status", "activeForm"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A table's own entry: a plain lookup would find "constructor" or "toString" too (registry.ts does the same).
const own = <T>(table: Record<string, T> | undefined, key: string): T | undefined => (table && Object.hasOwn(table, key) ? table[key] : undefined);

// The model's call as hooks see it. The model's input is not yet checked against the tool's schema, so a field of the
// wrong type is sent as it came; fields the tool does not have are left out, as its schema drops them.
export function toClaude(call: { name: string; input: unknown }, paths: Paths): { tool_name: string; tool_input: Record<string, unknown> } {
  const input = isObject(call.input) ? call.input : {};
  const spec = own(TOOLS, call.name);
  if (!spec) return { tool_name: call.name, tool_input: { ...input } };
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = input[f.ours];
    if (v === undefined) continue;
    if (f.kind === "path" && typeof v === "string") out[f.theirs] = paths.toHost(v);
    else if (f.kind === "todos" && Array.isArray(v)) {
      out[f.theirs] = v.map((t) => (isObject(t) ? { content: t.text, status: own(TO_CLAUDE, String(t.status)) ?? t.status } : t));
    }
    else out[f.theirs] = v;
  }
  return { tool_name: spec.claude, tool_input: { ...out, ...spec.sent } };
}

// A hook's rewrite (`updatedInput`, already an object, answer.ts) turned back into the input of the tool `name`, or why it
// cannot be: the words of a `problem` name the field. A field set to null is not set, as answer.ts reads one.
export function fromClaude(name: string, input: unknown, paths: Paths): { input: unknown } | { problem: string } {
  const spec = own(TOOLS, name);
  if (!spec) return { problem: "Tachikoma takes rewrites only for its own tools" };
  if (!isObject(input)) return { problem: '"updatedInput" must be an object' };
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = input[f.theirs];
    if (v == null) {
      if (f.required) return { problem: `"updatedInput" has no "${f.theirs}"` };
      continue;
    }
    const taken = take(f, v, paths);
    if ("problem" in taken) return taken;
    out[f.ours] = taken.value;
  }
  const known = new Set(spec.fields.map((f) => f.theirs));
  for (const [key, v] of Object.entries(input)) {
    if (v == null || known.has(key)) continue;
    const problem = extraProblem(key, v, own(spec.extra, key));
    if (problem) return { problem };
  }
  return { input: out };
}

function extraProblem(key: string, v: unknown, extra: Extra | undefined): string | undefined {
  if (extra === undefined) return `"${key}" is not a field Tachikoma can take`;
  if (extra === "label") return typeof v === "string" ? undefined : `"${key}" must be text in quotes`;
  if ("never" in extra) return `"${key}" cannot be set, as ${extra.never}`;
  return v === extra.only ? undefined : `"${key}" must be ${JSON.stringify(extra.only)}, as ${extra.as}`;
}

function take(f: Field, v: unknown, paths: Paths): { value: unknown } | { problem: string } {
  switch (f.kind) {
    case "text":
    case "path":
      if (typeof v !== "string") return { problem: `"${f.theirs}" must be text in quotes` };
      if (f.kind === "text") return { value: v };
      const p = paths.fromHost(v);
      return p === null ? { problem: `"${f.theirs}" is outside the project, which the sandbox cannot reach` } : { value: p };
    // Above 0, as read_file's schema takes them (files.ts).
    case "count":
      return Number.isInteger(v) && (v as number) >= 1 ? { value: v } : { problem: `"${f.theirs}" must be a whole number above 0` };
    case "flag":
      return typeof v === "boolean" ? { value: v } : { problem: `"${f.theirs}" must be true or false` };
    case "todos":
      return todosOf(v);
  }
}

function todosOf(v: unknown): { value: unknown } | { problem: string } {
  if (!Array.isArray(v)) return { problem: '"todos" must be a list' };
  const items: { text: string; status: string }[] = [];
  for (const t of v) {
    if (!isObject(t)) return { problem: 'each of "todos" must be an object' };
    const other = Object.keys(t).find((key) => t[key] != null && !TODO_FIELDS.includes(key));
    if (other !== undefined) return { problem: `"${other}" in "todos" is not a field Tachikoma can take` };
    if (t.content == null) return { problem: 'one of "todos" has no "content"' };
    if (typeof t.content !== "string") return { problem: 'each "content" in "todos" must be text in quotes' };
    if (t.status == null) return { problem: 'one of "todos" has no "status"' };
    const status = typeof t.status === "string" ? own(FROM_CLAUDE, t.status) : undefined;
    if (status === undefined) return { problem: 'each "status" in "todos" must be "pending", "in_progress" or "completed"' };
    if (t.activeForm != null && typeof t.activeForm !== "string") return { problem: 'each "activeForm" in "todos" must be text in quotes' };
    items.push({ text: t.content, status });
  }
  return { value: items };
}

// PostToolUse's `tool_response` (choice 11): Claude Code's shape where its docs give one and the tool reported its parts
// (ToolContext.report), else the text the model reads. `paths` turns Write's filePath into the path hooks see, as its
// file_path is; it is a parameter beyond the plan's interface, as the result alone cannot say where /work is.
export function responseOf(name: string, text: string, parts?: unknown, paths?: Paths): unknown {
  if (!isObject(parts)) return text;
  if (name === "shell" && typeof parts.stdout === "string" && typeof parts.stderr === "string") {
    return { stdout: parts.stdout, stderr: parts.stderr, interrupted: false, isImage: false };
  }
  if (name === "write_file" && typeof parts.path === "string") {
    return { filePath: paths ? paths.toHost(parts.path) : parts.path, type: parts.created ? "create" : "update" };
  }
  if (name === "delegate" && typeof parts.id === "string" && typeof parts.text === "string") {
    return { status: "completed", agentId: parts.id, content: [{ type: "text", text: parts.text }] };
  }
  return text;
}

// PostToolUseFailure's `error` (choice 12): a failed command's starts `Exit code <n>`, as Claude Code's Bash error does,
// then its error output, then its output, on a line of its own. A command a signal ended has no exit code, so it gets the
// shell's own text.
export function errorOf(name: string, text: string, parts?: unknown): string {
  if (name !== "shell" || !isObject(parts) || typeof parts.code !== "number") return text;
  const err = String(parts.stderr);
  return `Exit code ${parts.code}\n${err}${err && !err.endsWith("\n") ? "\n" : ""}${parts.stdout}`;
}

// The tools whose result Claude Code's docs give no shape for, so hooks get the text (choice 11) and may give text back.
const TEXT_RESULT = new Set(["read_file", "edit_file", "find_files", "search_files", "todo"]);

// A hook's `updatedToolOutput` as the text the model reads (choice 13), or null where it does not match the tool's result
// and is not used, as Claude Code ignores one. PostToolUse runs only after a call that succeeded, so a rebuilt shell
// result is exit code 0.
export function outputFrom(name: string, value: unknown): string | null {
  if (TEXT_RESULT.has(name)) return typeof value === "string" ? value : null;
  if (name === "shell" && isObject(value) && typeof value.stdout === "string" && typeof value.stderr === "string") {
    return shellText({ code: 0, signal: null, stdout: value.stdout, stderr: value.stderr });
  }
  // An empty content is no answer, so nothing the model could read.
  if (name === "delegate" && isObject(value) && Array.isArray(value.content) && value.content.length) {
    const texts = value.content.map((c) => (isObject(c) && c.type === "text" && typeof c.text === "string" ? c.text : null));
    return texts.includes(null) ? null : texts.join("\n");
  }
  return null;
}
