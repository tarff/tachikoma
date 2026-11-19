import path from "node:path";
import { commandEnv } from "../exec/env.js";
import type { MemoryPaths } from "./paths.js";

// The environments of the processes Tachikoma's own memory starts (8d plan, step 16): uv's, and the hub's, which the
// installer also asks MemPalace's version with. Both start from commandEnv, so they hold no API key. The user's own
// program (`"use"`) gets commandEnv and nothing more.

// The user's own settings, left out so that nothing of the user's MemPalace, uv or Python set-up reaches memory's
// processes (the build record, steps 3 to 5): every MEMPALACE_ variable (the user's choice at step 3); uv's and
// Python's own variables and VIRTUAL_ENV, which step 4 checked were absent before it installed; and what step 5's run
// left out so that nothing could switch a report or a download on: ANONYMIZED_TELEMETRY, CHROMA_* and
// TRANSFORMERS_OFFLINE, which Hugging Face's library reads beside HF_HUB_OFFLINE. Names are compared without regard to
// case, as Windows treats them.
const USERS = (name: string) =>
  ["MEMPALACE_", "UV_", "PYTHON", "CHROMA_"].some((start) => name.startsWith(start)) ||
  ["VIRTUAL_ENV", "ANONYMIZED_TELEMETRY", "TRANSFORMERS_OFFLINE"].includes(name);

// The given environment without the user's settings above or any spelling of a name set here, then those names. The
// home folder is the platform's own variable: Python's home is USERPROFILE on Windows and HOME elsewhere (step 5,
// ntpath.py:362 and posixpath.py:244). TEMP and TMP inside memory/ (the user's choice after step 8), and TMPDIR,
// which Python's tempfile looks at before them on every system.
function own(paths: MemoryPaths, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, set: Record<string, string>) {
  const all: Record<string, string> = {
    [platform === "win32" ? "USERPROFILE" : "HOME"]: paths.home,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    TMPDIR: paths.tmp,
    ...set,
  };
  const kept = Object.entries(commandEnv(env, platform)).filter(([name]) => {
    const upper = name.toUpperCase();
    return !(upper in all) && !USERS(upper);
  });
  return { ...Object.fromEntries(kept), ...all };
}

// uv's: its cache and its Pythons inside memory/ (step 1's helper; steps 3 and 4 also gave it the Python archives'
// and the Python links' folders, so nothing lands in the user's own uv folders or ~/.local/bin), no config file of the
// user's (UV_NO_CONFIG, steps 1 and 3), and only a Python it manages itself (UV_PYTHON_PREFERENCE, the user's choice at
// step 3).
export function uvEnv(
  paths: MemoryPaths,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return own(paths, env, platform, {
    UV_CACHE_DIR: paths.uvCache,
    UV_PYTHON_INSTALL_DIR: paths.python,
    UV_PYTHON_CACHE_DIR: paths.pythonCache,
    UV_PYTHON_BIN_DIR: paths.pythonBin,
    UV_NO_CONFIG: "1",
    UV_PYTHON_PREFERENCE: "only-managed",
  });
}

// The hub's, for Tachikoma's own palace only: MemPalace's config folder and the model cache in memory/'s home (step 1's
// helper), and step 5's settings for no download: the model chosen by its variable, as it has no flag (step 6 item
// 12), and Hugging Face's library kept offline. Every hub refuses at once to wait for another window's (Q8) and never
// quits when idle (Q25).
export function hubEnv(
  paths: MemoryPaths,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return own(paths, env, platform, {
    MEMPALACE_CONFIG_DIR: path.join(paths.home, ".config", "mempalace"),
    HF_HOME: path.join(paths.home, ".cache", "huggingface"),
    HF_HUB_OFFLINE: "1",
    MEMPALACE_EMBEDDING_MODEL: "minilm",
    MEMPALACE_MCP_WRITER_WAIT_SECONDS: "0",
    MEMPALACE_MCP_IDLE_HOURS: "0",
  });
}
