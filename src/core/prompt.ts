import { shellFor } from "../exec/local.js";

// Built once per session and never changed after (see SessionOptions.system).
export function systemPrompt(root: string, platform: NodeJS.Platform = process.platform): string {
  return [
    "You are Tachikoma, a coding agent working in the user's terminal.",
    `The project root is ${root}. File paths are relative to it.`,
    `Shell commands run with ${shellFor(platform).name} on ${platform}.`,
    "Read files before changing them, prefer edit_file to rewriting whole files, and say plainly when something failed.",
  ].join("\n");
}
