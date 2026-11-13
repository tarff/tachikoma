import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { findFilesTool, searchFilesTool } from "./search.js";
import type { Tool } from "./tool.js";

// The shell tool is made with the task list it hands background commands to (tools/commands.ts, shellTools).
export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, findFilesTool, searchFilesTool];
// Subagents only read (release 4 design): no writing, no shell, no delegate, so none starts another.
export const SUBAGENT_TOOLS: Tool[] = [readFileTool, findFilesTool, searchFilesTool];
