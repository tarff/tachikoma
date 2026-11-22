import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDir } from "../auth/private.js";
import { dataDir } from "../core/datadir.js";

// Tachikoma's own memory (8d plan, step 16): MemPalace's wing, the lessons' room, the folders under
// <data folder>/memory/, and each project's room.

// The lock file shipped beside the sandbox's Dockerfile (8d plan, step 3).
export const SHIPPED_LOCK = fileURLToPath(new URL("../../memory/uv.lock", import.meta.url));

export const WING = "tachikoma";
export const LESSONS = "lessons";

// The lock file's hash names the environment's folder, so a changed lock is a new environment. Taken as the sandbox
// image's tag is (src/sandbox/image.ts, imageFor and dockerText): the first 12 hex of the SHA-256 of the file's bytes
// with each \r\n read as \n, through latin1, so its line endings never change it.
export function lockHash(file = SHIPPED_LOCK): string {
  const text = Buffer.from(readFileSync(file, "latin1").replaceAll("\r\n", "\n"), "latin1");
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface MemoryPaths {
  root: string;
  // uv's own folders: its Pythons, its cache, the Python archives it keeps and the folder it may link Pythons into.
  python: string;
  uvCache: string;
  pythonCache: string;
  pythonBin: string;
  // TEMP and TMP for every process memory starts (the user's choice after step 8: uv otherwise leaves its lock files
  // in the user's Temp folder).
  tmp: string;
  // The environment the lock is installed into, and its own Python, which the installer and the hub start (Q24).
  env: string;
  envPython: string;
  home: string;
  // APPDATA and LOCALAPPDATA on Windows, inside the home as Windows lays them out (the user's choice after the final
  // review, "Redirect AppData too", as tests/memory/real.test.ts's real run had them).
  appData: string;
  localAppData: string;
  // The four XDG base folders on every system, where the XDG spec puts them under a home (the user's choice after the
  // final review's re-check, "Fix both").
  xdgData: string;
  xdgState: string;
  xdgCache: string;
  xdgConfig: string;
  palace: string;
}

export function memoryPaths(
  data = dataDir(),
  hash = lockHash(),
  platform: NodeJS.Platform = process.platform,
): MemoryPaths {
  const root = path.join(data, "memory");
  const env = path.join(root, "env", hash);
  const home = path.join(root, "home");
  return {
    root,
    python: path.join(root, "python"),
    uvCache: path.join(root, "uv-cache"),
    pythonCache: path.join(root, "python-cache"),
    pythonBin: path.join(root, "python-bin"),
    tmp: path.join(root, "tmp"),
    env,
    envPython: platform === "win32" ? path.join(env, "Scripts", "python.exe") : path.join(env, "bin", "python"),
    home,
    appData: path.join(home, "AppData", "Roaming"),
    localAppData: path.join(home, "AppData", "Local"),
    xdgData: path.join(home, ".local", "share"),
    xdgState: path.join(home, ".local", "state"),
    xdgCache: path.join(home, ".cache"),
    xdgConfig: path.join(home, ".config"),
    palace: path.join(root, "palace"),
  };
}

// Makes memory/ and keeps it private; what is made inside it inherits that.
export function makeMemoryFolder(paths: MemoryPaths): void {
  privateDir(paths.root);
}

// The longest name part: MemPalace's room names hold at most 128 characters (step 6 item 10), less a hyphen and the
// 8 hex of the code (Q19).
const NAME_MAX = 119;

// A project's room (Q19): the folder's own name made to fit MemPalace's rules for a room, a hyphen, and the first 8
// hex of the SHA-256 of the folder's real path, resolved as projectFile resolves it (src/core/datadir.ts). MemPalace's
// rules (step 6 item 10; config.py:36-37, :137-162): at most 128 characters, as Python counts them (code points); the
// first and the last a letter or a digit, of any script, as Python's \w is in a text pattern; between them also `_`,
// space, `.`, `'` and `-`; no `..`, `/` or `\`. So a character outside them becomes `_`, a run of dots one dot,
// anything before the first letter or digit is dropped, and the rest is cut to 119 characters; a name with nothing
// left gives the code alone. The code's last character is a hex digit, and no `..` can form across the hyphen. The
// name keeps its letters' case, as MemPalace matches a room's name case for case; every room ends in its code, so
// none is `lessons`.
export function roomName(folder: string): string {
  let real: string;
  try {
    real = realpathSync.native(folder); // Windows gives the folder's own case, whatever was typed
  } catch {
    real = path.resolve(folder);
  }
  const code = createHash("sha256").update(real).digest("hex").slice(0, 8);
  const fitted = Array.from(path.basename(real), (c) => (/^[\p{L}\p{N}_ .'-]$/u.test(c) ? c : "_"))
    .join("")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^\p{L}\p{N}]+/u, "");
  const name = Array.from(fitted).slice(0, NAME_MAX).join("");
  return name ? `${name}-${code}` : code;
}
