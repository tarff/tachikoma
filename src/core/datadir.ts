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
