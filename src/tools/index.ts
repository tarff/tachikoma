import { editFileTool, readFileTool, writeFileTool } from "./files.js";
import { findFilesTool, searchFilesTool } from "./search.js";
import { shellTool } from "./shell.js";
import type { Tool } from "./tool.js";

export const TOOLS: Tool[] = [readFileTool, writeFileTool, editFileTool, shellTool, findFilesTool, searchFilesTool];
