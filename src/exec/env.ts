import path from "node:path";

// The API keys Tachikoma reads. Commands never see them, so one cannot print a key back to the model
// (release 2 design, "Hardening for every provider"). A command that needs one of these keys does not
// get it either.
export const API_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "MOONSHOT_API_KEY"];

// Windows treats variable names without regard to case, so `openai_api_key` is the same variable.
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !API_KEYS.includes(name.toUpperCase())));
}

// A Windows program by its full path, so a program of the same name earlier on PATH (Git Bash has its
// own whoami) is not run instead.
export const system32 = (exe: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
