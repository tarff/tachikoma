import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bus } from "../../src/core/bus.js";
import { PermissionGate } from "../../src/core/permissions.js";
import { Tasks } from "../../src/core/tasks.js";
import { errorOf, fromClaude, outputFrom, pathsFor, responseOf, toClaude } from "../../src/hooks/tools.js";
import { delegateTool } from "../../src/tools/delegate.js";
import { writeFileTool } from "../../src/tools/files.js";
import { SUBAGENT_TOOLS } from "../../src/tools/index.js";
import { shellTool } from "../../src/tools/shell.js";
import { FakeProvider, reply, tempContext } from "../helpers.js";

// No hook runs here, and no path is opened but the test's own folder (release 8b plan, "Rules for every task").
const HOST = pathsFor("/proj", null, "linux");
const WINDOWS = pathsFor("C:\\proj", null, "win32");
const LIVE = pathsFor("C:\\proj", { mode: "live" }, "win32");
const COPY = pathsFor("C:\\proj", { mode: "copy" }, "win32");

// Each tool's input in the form the tool takes, with its path whole, and what hooks are sent for it (design, "Tool hooks").
const CASES: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
  ["shell", { command: "npm test" }, "Bash", { command: "npm test" }],
  ["read_file", { path: "/proj/a.ts", offset: 3, limit: 10 }, "Read", { file_path: "/proj/a.ts", offset: 3, limit: 10 }],
  ["write_file", { path: "/proj/a.ts", content: "x\n" }, "Write", { file_path: "/proj/a.ts", content: "x\n" }],
  ["edit_file", { path: "/proj/a.ts", old_text: "a", new_text: "b" }, "Edit", { file_path: "/proj/a.ts", old_string: "a", new_string: "b" }],
  ["find_files", { pattern: "src/**/*.ts" }, "Glob", { pattern: "src/**/*.ts" }],
  ["search_files", { pattern: "max", path: "/proj/src", glob: "*.ts" }, "Grep", { pattern: "max", path: "/proj/src", glob: "*.ts" }],
  ["delegate", { description: "find x", task: "Find where x is set.", background: true }, "Agent", {
    description: "find x", prompt: "Find where x is set.", run_in_background: true, subagent_type: "Explore" }],
  ["todo", { items: [{ text: "one", status: "done" }, { text: "two", status: "in_progress" }] }, "TodoWrite", {
    todos: [{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }] }],
];

describe("toClaude and fromClaude: every tool both ways", () => {
  it.each(CASES)("%s is sent as %s, and its input comes back as it was", (name, input, claude, sent) => {
    const call = toClaude({ name, input }, HOST);
    expect(call).toEqual({ tool_name: claude, tool_input: sent });
    expect(fromClaude(name, call.tool_input, HOST)).toEqual({ input });
  });

  it("leaves out the optional fields the model left out", () => {
    expect(toClaude({ name: "read_file", input: { path: "/proj/a.ts" } }, HOST).tool_input).toEqual({ file_path: "/proj/a.ts" });
    expect(toClaude({ name: "search_files", input: { pattern: "x" } }, HOST).tool_input).toEqual({ pattern: "x" });
    expect(toClaude({ name: "delegate", input: { description: "d", task: "t" } }, HOST).tool_input).toEqual({
      description: "d", prompt: "t", subagent_type: "Explore" });
    expect(fromClaude("read_file", { file_path: "/proj/a.ts" }, HOST)).toEqual({ input: { path: "/proj/a.ts" } });
  });

  // Claude Code's file_path is always whole (its hooks reference); the model's may be relative to the project.
  it("makes a path whole against the project's root", () => {
    expect(toClaude({ name: "read_file", input: { path: "src/a.ts" } }, HOST).tool_input).toEqual({ file_path: "/proj/src/a.ts" });
    expect(toClaude({ name: "search_files", input: { pattern: "x", path: "." } }, HOST).tool_input).toEqual({ pattern: "x", path: "/proj" });
  });

  it("sends a tool it does not know by its own name, with its input", () => {
    expect(toClaude({ name: "other", input: { a: 1 } }, HOST)).toEqual({ tool_name: "other", tool_input: { a: 1 } });
    expect(toClaude({ name: "other", input: "text" }, HOST)).toEqual({ tool_name: "other", tool_input: {} });
  });

  // The session fires PreToolUse before the tool's own check, so the model's input may be any shape.
  it("sends an input of the wrong shape as it came, field by field", () => {
    expect(toClaude({ name: "read_file", input: { path: 7, extra: true } }, HOST).tool_input).toEqual({ file_path: 7 });
    expect(toClaude({ name: "todo", input: { items: "none" } }, HOST).tool_input).toEqual({ todos: "none" });
    expect(toClaude({ name: "shell", input: null }, HOST).tool_input).toEqual({});
  });
});

describe("pathsFor: the paths hooks see", () => {
  it("on Windows, sends the host's paths with backslashes, as Claude Code does", () => {
    expect(toClaude({ name: "read_file", input: { path: "src/a.ts" } }, WINDOWS).tool_input).toEqual({ file_path: "C:\\proj\\src\\a.ts" });
    expect(fromClaude("write_file", { file_path: "C:\\proj\\src\\b.ts", content: "" }, WINDOWS)).toEqual({
      input: { path: "C:\\proj\\src\\b.ts", content: "" } });
  });

  it("in live link, turns the box's /work into the real project, and back", () => {
    expect(LIVE.toHost("/work/src/a.ts")).toBe("C:\\proj\\src\\a.ts");
    expect(LIVE.toHost("src/a.ts")).toBe("C:\\proj\\src\\a.ts");
    expect(LIVE.toHost("/work")).toBe("C:\\proj");
    expect(LIVE.fromHost("C:\\proj\\src\\a.ts")).toBe("/work/src/a.ts");
    expect(LIVE.fromHost("C:\\proj")).toBe("/work");
    const call = toClaude({ name: "edit_file", input: { path: "/work/a.ts", old_text: "a", new_text: "b" } }, LIVE);
    expect(call.tool_input).toEqual({ file_path: "C:\\proj\\a.ts", old_string: "a", new_string: "b" });
    expect(fromClaude("edit_file", call.tool_input, LIVE)).toEqual({ input: { path: "/work/a.ts", old_text: "a", new_text: "b" } });
  });

  it("in live link, leaves a box path outside /work, and a path not whole, as they are", () => {
    expect(LIVE.toHost("/etc/hosts")).toBe("/etc/hosts");
    expect(LIVE.fromHost("/etc/hosts")).toBe("/etc/hosts");
    expect(LIVE.fromHost("/work/a.ts")).toBe("/work/a.ts");
    expect(LIVE.fromHost("src\\a.ts")).toBe("src\\a.ts");
  });

  // The user's choice, 2026-11-09: the box would take it as a name in /work.
  it("in live link, refuses a rewritten path outside the project", () => {
    expect(LIVE.fromHost("C:\\other\\a.ts")).toBeNull();
    expect(LIVE.fromHost("\\\\server\\share\\a.ts")).toBeNull();
    expect(fromClaude("read_file", { file_path: "C:\\other\\a.ts" }, LIVE)).toEqual({
      problem: '"file_path" is outside the project, which the sandbox cannot reach' });
    expect(fromClaude("search_files", { pattern: "x", path: "C:\\other" }, LIVE)).toEqual({
      problem: '"path" is outside the project, which the sandbox cannot reach' });
    // Off Windows a host path and a box path look alike; hooks are sent host paths in live link, so it is the host's.
    const linux = pathsFor("/proj", { mode: "live" }, "linux");
    expect(linux.fromHost("/home/u/a.ts")).toBeNull();
    expect(linux.fromHost("/proj/a.ts")).toBe("/work/a.ts");
  });

  it("on the host, leaves a rewritten path outside the project for the gate", () => {
    expect(fromClaude("read_file", { file_path: "C:\\other\\a.ts" }, WINDOWS)).toEqual({ input: { path: "C:\\other\\a.ts" } });
    expect(fromClaude("read_file", { file_path: "/other/a.ts" }, HOST)).toEqual({ input: { path: "/other/a.ts" } });
  });

  // The user's choice, 2026-11-09: its place in the copy, the file the tool works on.
  it("in copy mode, turns a Windows host path in the project into its place in the copy", () => {
    expect(COPY.fromHost("C:\\proj\\src\\a.ts")).toBe("/work/src/a.ts");
    expect(COPY.fromHost("C:\\proj")).toBe("/work");
    expect(fromClaude("edit_file", { file_path: "C:\\proj\\a.ts", old_string: "a", new_string: "b" }, COPY)).toEqual({
      input: { path: "/work/a.ts", old_text: "a", new_text: "b" } });
  });

  // The box resolves C:\other\a.ts against /work as one odd name in it, as in live link.
  it("in copy mode, refuses a Windows host path outside the project, and keeps the box's own paths", () => {
    expect(COPY.fromHost("C:\\other\\a.ts")).toBeNull();
    expect(fromClaude("write_file", { file_path: "C:\\other\\a.ts", content: "" }, COPY)).toEqual({
      problem: '"file_path" is outside the project, which the sandbox cannot reach' });
    expect(fromClaude("search_files", { pattern: "x", path: "\\\\server\\share" }, COPY)).toEqual({
      problem: '"path" is outside the project, which the sandbox cannot reach' });
    expect(COPY.fromHost("/etc/hosts")).toBe("/etc/hosts");
    expect(COPY.fromHost("src\\a.ts")).toBe("src\\a.ts");
    // Off Windows, hooks are sent the box's paths in copy mode, so a whole path is the box's.
    expect(pathsFor("/proj", { mode: "copy" }, "linux").fromHost("/home/u/a.ts")).toBe("/home/u/a.ts");
  });

  // Design, "Tool hooks": real in live, the box's in copy.
  it("in copy mode, keeps the box's /work paths both ways", () => {
    expect(COPY.toHost("src/a.ts")).toBe("/work/src/a.ts");
    expect(COPY.toHost("/work/src/a.ts")).toBe("/work/src/a.ts");
    expect(COPY.fromHost("/work/src/a.ts")).toBe("/work/src/a.ts");
    const call = toClaude({ name: "search_files", input: { pattern: "x", path: "src" } }, COPY);
    expect(call.tool_input).toEqual({ pattern: "x", path: "/work/src" });
    expect(fromClaude("search_files", call.tool_input, COPY)).toEqual({ input: { pattern: "x", path: "/work/src" } });
  });
});

describe("fromClaude: a rewrite Tachikoma cannot take", () => {
  it.each<[string, string, unknown, string]>([
    ["a tool without a table entry", "other", { a: 1 }, "Tachikoma takes rewrites only for its own tools"],
    ["an input that is not an object", "shell", "ls", '"updatedInput" must be an object'],
    ["a missing field", "shell", {}, '"updatedInput" has no "command"'],
    ["a missing path", "write_file", { content: "x" }, '"updatedInput" has no "file_path"'],
    ["text of the wrong type", "shell", { command: 3 }, '"command" must be text in quotes'],
    ["a path of the wrong type", "read_file", { file_path: ["a"] }, '"file_path" must be text in quotes'],
    ["a count that is not a whole number", "read_file", { file_path: "/proj/a", offset: 1.5 }, '"offset" must be a whole number above 0'],
    ["a count of 0", "read_file", { file_path: "/proj/a", limit: 0 }, '"limit" must be a whole number above 0'],
    ["a flag that is not true or false", "delegate", { description: "d", prompt: "p", run_in_background: "yes" }, '"run_in_background" must be true or false'],
    ["a field neither choice 14 nor Tachikoma's tool has", "search_files", { pattern: "x", head_limit: 5 }, '"head_limit" is not a field Tachikoma can take'],
    ["todos that are not a list", "todo", { todos: {} }, '"todos" must be a list'],
    ["a todo that is not an object", "todo", { todos: ["one"] }, 'each of "todos" must be an object'],
    ["a todo without content", "todo", { todos: [{ status: "pending" }] }, 'one of "todos" has no "content"'],
    ["a todo's content of the wrong type", "todo", { todos: [{ content: 1, status: "pending" }] }, 'each "content" in "todos" must be text in quotes'],
    ["a todo without status", "todo", { todos: [{ content: "a" }] }, 'one of "todos" has no "status"'],
    ["a todo's unknown status", "todo", { todos: [{ content: "a", status: "done" }] },
      'each "status" in "todos" must be "pending", "in_progress" or "completed"'],
    ["a todo's activeForm of the wrong type", "todo", { todos: [{ content: "a", status: "pending", activeForm: 1 }] },
      'each "activeForm" in "todos" must be text in quotes'],
    ["a todo's unknown field", "todo", { todos: [{ content: "a", status: "pending", priority: "high" }] },
      '"priority" in "todos" is not a field Tachikoma can take'],
    ["Bash's description of the wrong type", "shell", { command: "ls", description: 1 }, '"description" must be text in quotes'],
  ])("%s", (_, name, input, problem) => {
    expect(fromClaude(name, input, HOST)).toEqual({ problem });
  });

  // Release 8b plan, choice 14: the fields Claude Code has and Tachikoma has not, set other than Tachikoma's own way.
  it.each<[string, string, Record<string, unknown>, string]>([
    ["Edit's replace_all: true", "edit_file", { file_path: "/proj/a", old_string: "a", new_string: "b", replace_all: true },
      '"replace_all" must be false, as Tachikoma\'s edit_file replaces one exact match'],
    ["Bash's run_in_background: true", "shell", { command: "ls", run_in_background: true },
      '"run_in_background" must be false, as Tachikoma\'s shell cannot run a command in the background'],
    ["Bash's timeout", "shell", { command: "ls", timeout: 1000 }, '"timeout" cannot be set, as Tachikoma\'s shell has no time limit'],
    ["Grep's output_mode", "search_files", { pattern: "x", output_mode: "count" },
      '"output_mode" must be "content", as Tachikoma\'s search_files gives the matching lines'],
    ["Grep's -i", "search_files", { pattern: "x", "-i": true }, '"-i" must be false, as Tachikoma\'s search_files matches letter case exactly'],
    ["Grep's multiline", "search_files", { pattern: "x", multiline: true }, '"multiline" must be false, as Tachikoma\'s search_files matches within one line'],
    ["Glob's path", "find_files", { pattern: "*.ts", path: "/proj/src" }, '"path" cannot be set, as Tachikoma\'s find_files searches the whole project'],
    ["Agent's subagent_type", "delegate", { description: "d", prompt: "p", subagent_type: "general-purpose" },
      '"subagent_type" must be "Explore", as Tachikoma\'s subagents only read'],
    ["Agent's model", "delegate", { description: "d", prompt: "p", model: "opus" },
      '"model" cannot be set, as a subagent runs on the model --worker names, or else the lead\'s'],
  ])("%s", (_, name, input, problem) => {
    expect(fromClaude(name, input, HOST)).toEqual({ problem });
  });

  it("takes those fields at Tachikoma's own way, and Claude Code's labels, leaving them out", () => {
    expect(fromClaude("edit_file", { file_path: "/proj/a", old_string: "a", new_string: "b", replace_all: false }, HOST)).toEqual({
      input: { path: "/proj/a", old_text: "a", new_text: "b" } });
    expect(fromClaude("shell", { command: "ls", run_in_background: false, description: "List files" }, HOST)).toEqual({ input: { command: "ls" } });
    expect(fromClaude("search_files", { pattern: "x", output_mode: "content", "-i": false, multiline: false }, HOST)).toEqual({ input: { pattern: "x" } });
    expect(fromClaude("delegate", { description: "d", prompt: "p", subagent_type: "Explore" }, HOST)).toEqual({ input: { description: "d", task: "p" } });
    expect(fromClaude("todo", { todos: [{ content: "a", status: "completed", activeForm: "Doing a" }] }, HOST)).toEqual({
      input: { items: [{ text: "a", status: "done" }] } });
  });

  // answer.ts reads a field set to null as not set; so does this.
  it("takes null for a field as not set", () => {
    expect(fromClaude("read_file", { file_path: "/proj/a", offset: null }, HOST)).toEqual({ input: { path: "/proj/a" } });
    expect(fromClaude("shell", { command: null }, HOST)).toEqual({ problem: '"updatedInput" has no "command"' });
  });
});

describe("responseOf and errorOf: what PostToolUse and PostToolUseFailure are sent", () => {
  it("gives Bash's shape from the shell's parts", () => {
    expect(responseOf("shell", "exit code: 0\n...", { stdout: "hi\n", stderr: "", code: 0 })).toEqual({
      stdout: "hi\n", stderr: "", interrupted: false, isImage: false });
  });

  it("gives Agent's shape from the delegate's parts", () => {
    expect(responseOf("delegate", "It is in a.ts", { id: "t1", text: "It is in a.ts" })).toEqual({
      status: "completed", agentId: "t1", content: [{ type: "text", text: "It is in a.ts" }] });
  });

  it("gives Write's shape, its filePath as hooks see paths", () => {
    expect(responseOf("write_file", "Wrote 1 characters to a.ts", { path: "/work/a.ts", created: true }, LIVE)).toEqual({
      filePath: "C:\\proj\\a.ts", type: "create" });
  });

  it("gives the text the model reads for the other tools, and for a tool that reported nothing", () => {
    for (const name of ["read_file", "edit_file", "find_files", "search_files", "todo", "other"]) expect(responseOf(name, "the text")).toBe("the text");
    expect(responseOf("shell", "the text")).toBe("the text");
  });

  // Release 8b plan, choice 12.
  it("starts Bash's error with its exit code, then its error output, then its output", () => {
    expect(errorOf("shell", "exit code: 1\n...", { stdout: "out\n", stderr: "err\n", code: 1 })).toBe("Exit code 1\nerr\nout\n");
  });

  it("gives the error's text for the other tools, and for a command a signal ended", () => {
    expect(errorOf("read_file", "a.ts was not found")).toBe("a.ts was not found");
    expect(errorOf("shell", "killed by SIGKILL\n...", { stdout: "", stderr: "", code: null })).toBe("killed by SIGKILL\n...");
  });
});

describe("outputFrom: a hook's updatedToolOutput, turned back into what the model reads", () => {
  it("takes text for the tools whose result is the text", () => {
    for (const name of ["read_file", "edit_file", "find_files", "search_files", "todo"]) expect(outputFrom(name, "new text")).toBe("new text");
  });

  it("rebuilds Bash's shape into the shell tool's own layout", () => {
    expect(outputFrom("shell", { stdout: "out", stderr: "err", interrupted: false, isImage: false })).toBe(
      "exit code: 0\n--- stderr ---\nerr\n--- stdout ---\nout");
  });

  it("takes Agent's content text", () => {
    expect(outputFrom("delegate", { status: "completed", agentId: "t1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("uses nothing of a shape that does not match", () => {
    expect(outputFrom("read_file", { text: "x" })).toBeNull();
    expect(outputFrom("shell", "plain")).toBeNull();
    expect(outputFrom("shell", { stdout: "out" })).toBeNull();
    expect(outputFrom("delegate", { content: [{ type: "image" }] })).toBeNull();
    expect(outputFrom("delegate", "plain")).toBeNull();
    expect(outputFrom("write_file", { filePath: "a", type: "create" })).toBeNull();
    expect(outputFrom("other", "x")).toBeNull();
  });
});

// Release 8b plan, choice 12: the tools tell the session their result's parts.
describe("report: the parts the tools give", () => {
  it("shell reports its output and exit code, on success and on failure", async () => {
    const ctx = await tempContext("never");
    const parts: unknown[] = [];
    const executor = { exec: async () => ({ code: 1, signal: null, stdout: "out\n", stderr: "err\n" }) };
    await expect(shellTool.run({ command: "false" }, { ...ctx, executor, report: (p) => parts.push(p) })).rejects.toThrow("exit code: 1");
    expect(parts).toEqual([{ stdout: "out\n", stderr: "err\n", code: 1 }]);
    expect(errorOf("shell", "", parts[0])).toMatch(/^Exit code 1\n/);
  });

  it("write_file reports whether the file was new, so Write's type is create, then update", async () => {
    const ctx = await tempContext("never");
    const parts: unknown[] = [];
    const run = { ...ctx, report: (p: unknown) => parts.push(p) };
    await writeFileTool.run({ path: "new.txt", content: "a" }, run);
    writeFileSync(path.join(ctx.root, "there.txt"), "old");
    await writeFileTool.run({ path: "there.txt", content: "b" }, run);
    const paths = pathsFor(ctx.root, null);
    expect(parts.map((p) => responseOf("write_file", "", p, paths))).toEqual([
      { filePath: path.join(ctx.root, "new.txt"), type: "create" },
      { filePath: path.join(ctx.root, "there.txt"), type: "update" },
    ]);
  });

  it("delegate reports the subagent's id and answer", async () => {
    const ctx = await tempContext();
    const worker = new FakeProvider("w", [reply("It is in a.ts")]);
    const gate = new PermissionGate("project", async () => false);
    const tasks = new Tasks({ bus: new Bus(), max: 8, worker: () => worker, system: "sub", tools: SUBAGENT_TOOLS, ctx: { ...ctx, gate } });
    const parts: unknown[] = [];
    await delegateTool(tasks, { headless: false }).run({ description: "find x", task: "find x" }, { ...ctx, report: (p) => parts.push(p) });
    expect(parts).toEqual([{ id: "t1", text: "It is in a.ts" }]);
  });
});
