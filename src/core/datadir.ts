import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Where Tachikoma keeps its own data, such as the saved ChatGPT login (design, "Install").
// TACHI_DATA_DIR moves it, so tests never touch the real one.
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  if (env.TACHI_DATA_DIR) return env.TACHI_DATA_DIR;
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "tachikoma");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "tachikoma");
  return path.join(home, ".local", "share", "tachikoma");
}

// A file of the project folder's own in the data folder, such as its prompt history (release 3 design, "How it is
// built") or its error log (review fixes plan, fix 3): named after the folder's real path, so two ways of writing one
// folder share it.
export function projectFile(folder: string, root: string, data = dataDir()): string {
  let real: string;
  try {
    real = realpathSync.native(root); // Windows gives the folder's own case, whatever was typed
  } catch {
    real = path.resolve(root);
  }
  return path.join(data, folder, `${createHash("sha256").update(real).digest("hex")}.jsonl`);
}

// The settings file (release 6 design, "The settings file"): ~/.tachikoma/settings.json, the only one read, so a
// repository the user clones can never change how Tachikoma behaves. The keys file is beside it.
export const SETTINGS = "settings.json";
export const KEYBINDINGS = "keybindings.json";
export const SETTINGS_DIR = ".tachikoma";

export function settingsDir(home = os.homedir()): string {
  return path.join(home, SETTINGS_DIR);
}
