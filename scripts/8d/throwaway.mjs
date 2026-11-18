// The build folder for release 8d, and the snapshot of the user's own folders (8d plan, step 1). Not part of Tachikoma:
// used by the build's scripts, and run by hand.
//
//   node scripts/8d/throwaway.mjs snapshot <label> [<earlier label>]
//
// Everything uv, Python or MemPalace does during the build happens in a sub-folder of the build folder, with an
// environment from `throwaway`: the home, the uv cache and Pythons, MemPalace's config and the model cache all inside
// that sub-folder, no API keys, and UV_NO_CONFIG=1 so uv reads no config file of the user's (APPDATA is not moved,
// so %APPDATA%\uv\uv.toml would otherwise be read). The snapshot lists names, sizes and change times under the user's
// own MemPalace and uv folders, opens no file in them, changes nothing and follows no link; it is saved in the build
// folder as <label>.json, and, given an earlier label, compared with it, printing "no change" or each difference.
// Changes in the two places the user's own MemPalace writes by itself are printed apart and do not count
// (`ownMemPalace`, below).
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commandEnv } from "../../src/exec/env.ts";

export const BUILD = path.join(tmpdir(), "tachi-8d-build");

// A plain folder or file name, so nothing built from it lands outside the folder it is joined to.
function plain(name) {
  if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") throw new Error(`not a plain name: ${name}`);
  return name;
}

// Makes <root>/<name> and its home folder, and returns them with the environment for child processes run there.
export function throwaway(name, { root = BUILD, env = process.env } = {}) {
  const dir = path.join(root, plain(name));
  const home = path.join(dir, "home");
  mkdirSync(home, { recursive: true });
  const set = {
    USERPROFILE: home,
    HOME: home,
    UV_CACHE_DIR: path.join(dir, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: path.join(dir, "python"),
    MEMPALACE_CONFIG_DIR: path.join(home, ".config", "mempalace"),
    HF_HOME: path.join(home, ".cache", "huggingface"),
    // uv's own list of variables (https://docs.astral.sh/uv/reference/environment/, UV_NO_CONFIG, added in 0.2.30):
    // "If set, uv will not read any configuration files from the current directory, parent directories, or user
    // configuration directories." The user-level one is %APPDATA%\uv\uv.toml on Windows
    // (https://docs.astral.sh/uv/concepts/configuration-files/). The user's choice after step 1's review.
    UV_NO_CONFIG: "1",
  };
  // Windows treats names without regard to case, so another spelling of one of these is dropped, not kept beside it.
  const kept = Object.entries(commandEnv(env)).filter(([k]) => !(k.toUpperCase() in set));
  return { dir, env: { ...Object.fromEntries(kept), ...set } };
}

// The user's folders the snapshot watches.
export function userFolders(home = homedir()) {
  return {
    "~/.mempalace": path.join(home, ".mempalace"),
    "~/.cache": path.join(home, ".cache"),
    "~/.config/mempalace": path.join(home, ".config", "mempalace"),
    "AppData/Roaming/uv": path.join(home, "AppData", "Roaming", "uv"),
    "AppData/Local/uv": path.join(home, "AppData", "Local", "uv"),
    "~/.local/bin": path.join(home, ".local", "bin"),
  };
}

const link = (p) => {
  try {
    return `link ${readlinkSync(p)}`;
  } catch {
    return "link";
  }
};

const details = (p, kind) => {
  const s = lstatSync(p);
  return `${kind} ${kind === "file" ? s.size : "-"} ${s.mtimeMs} ${s.ctimeMs}`;
};

// Each watched folder's entries, by path within it. A folder is gone into only when its listing says it is a folder
// and not a link or junction; a link is recorded by what it points to, never followed.
export function snapshot(folders = userFolders()) {
  const result = {};
  for (const [label, root] of Object.entries(folders)) {
    let top;
    try {
      top = lstatSync(root);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      result[label] = { path: root, missing: true };
      continue;
    }
    if (top.isSymbolicLink()) {
      result[label] = { path: root, link: link(root) };
      continue;
    }
    const entries = {};
    const walk = (dir, rel) => {
      let list;
      try {
        list = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        entries[rel || "."] = `unreadable ${e.code}`;
        return;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) entries[r] = link(p);
        else if (e.isDirectory()) {
          entries[r] = details(p, "dir");
          walk(p, r);
        } else if (e.isFile()) entries[r] = details(p, "file");
        else entries[r] = "other";
      }
    };
    walk(root, "");
    result[label] = { path: root, entries };
  }
  return result;
}

// The two places the user's own MemPalace writes by itself while it runs, by exact path in ~/.mempalace: a folder
// directly under daemon/ (its own times) and what lies directly in it, and hook_state/hook.log; with the folders daemon
// and hook_state themselves, whose own times change when a daemon folder comes or goes or the hook log is made again.
// A change there is set apart, still shown, and does not fail the comparison (the user's choice at step 1, "Set apart,
// still shown", and after step 1's review). Any other file in hook_state still fails.
const ownMemPalace = (label, rel) => {
  if (label !== "~/.mempalace") return false;
  const parts = rel.split("/");
  return rel === "hook_state" || rel === "hook_state/hook.log" || (parts[0] === "daemon" && parts.length <= 3);
};

// Each difference between two snapshots, one line each: `changes` fail the comparison, `apart` are the user's own
// MemPalace at work. Both are empty when nothing changed.
export function compare(before, after) {
  const changes = [];
  const apart = [];
  for (const label of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[label];
    const b = after[label];
    const state = (f) => (!f ? "not watched" : f.missing ? "missing" : f.link ? f.link : "present");
    if (state(a) !== state(b)) {
      changes.push(`${label}: ${state(a)} -> ${state(b)}`);
      continue;
    }
    const ea = a?.entries ?? {};
    const eb = b?.entries ?? {};
    for (const r of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
      const out = ownMemPalace(label, r) ? apart : changes;
      if (!(r in eb)) out.push(`${label}: removed ${r}`);
      else if (!(r in ea)) out.push(`${label}: added ${r}`);
      else if (ea[r] !== eb[r]) out.push(`${label}: changed ${r} (${ea[r]} -> ${eb[r]})`);
    }
  }
  return { changes, apart };
}

// Writes a snapshot as <root>/snapshots/<label>.json and returns the file's path.
export function saveSnapshot(label, snap, root = BUILD) {
  const dir = path.join(root, "snapshots");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plain(label)}.json`);
  writeFileSync(file, JSON.stringify(snap));
  return file;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, label, earlier] = process.argv.slice(2);
  if (command !== "snapshot" || !label) {
    console.error("usage: node scripts/8d/throwaway.mjs snapshot <label> [<earlier label>]");
    process.exit(2);
  }
  const snap = snapshot();
  const file = saveSnapshot(label, snap);
  const counts = Object.entries(snap).map(
    ([k, f]) => `${k}: ${f.missing ? "missing" : (f.link ?? `${Object.keys(f.entries).length} entries`)}`,
  );
  console.log(`saved ${file}\n${counts.join("\n")}`);
  if (earlier) {
    const old = JSON.parse(readFileSync(path.join(BUILD, "snapshots", `${plain(earlier)}.json`), "utf8"));
    const { changes, apart } = compare(old, snap);
    for (const line of apart) console.log(`set apart, the user's own MemPalace at work: ${line}`);
    console.log(changes.length ? changes.join("\n") : "no change");
    if (changes.length) process.exitCode = 1;
  }
}
