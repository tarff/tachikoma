import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { compare, saveSnapshot, snapshot, throwaway } from "../../scripts/8d/throwaway.mjs";
import { API_KEYS } from "../../src/exec/env.js";
import { removeTree } from "../helpers.js";

// A folder this test makes, removed when the test ends; never the user's folders, never the real build folder.
function made(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tachi-8d-throwaway-test-"));
  onTestFinished(() => removeTree(dir));
  return dir;
}

const inside = (folder: string, file: string) => {
  const rel = path.relative(folder, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

describe("throwaway", () => {
  it("points each of the six variables inside the folder it makes", () => {
    const root = made();
    const given = { PATH: "/bin", USERPROFILE: "C:\\Users\\me", home: "/home/me" };
    const { dir, env } = throwaway("one", { root, env: given });
    expect(dir).toBe(path.join(root, "one"));
    const six = ["USERPROFILE", "HOME", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "MEMPALACE_CONFIG_DIR", "HF_HOME"];
    for (const name of six) expect(inside(dir, env[name] ?? ""), name).toBe(true);
    // No other spelling of those names is left to stand beside them.
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "HOME")).toEqual(["HOME"]);
    expect(env.PATH).toBe("/bin");
  });

  // The user's choice after step 1's review: uv reads no config file of the user's (%APPDATA%\uv\uv.toml), as the six
  // variables do not move APPDATA. UV_NO_CONFIG is from uv's own list of variables
  // (https://docs.astral.sh/uv/reference/environment/).
  it("tells uv to read no config file, whatever the given environment says", () => {
    const { env } = throwaway("three", { root: made(), env: { PATH: "/bin", uv_no_config: "0", APPDATA: "C:\\a" } });
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "UV_NO_CONFIG")).toEqual(["UV_NO_CONFIG"]);
    expect(env.UV_NO_CONFIG).toBe("1");
    expect(env.APPDATA).toBe("C:\\a");
  });

  // The user's choice at step 3: the user's own MemPalace settings in their environment never reach the build's
  // MemPalace, in any spelling; MEMPALACE_CONFIG_DIR is the build's own.
  it("drops every MEMPALACE_ variable of the given environment but the one it sets", () => {
    const given = {
      PATH: "/bin",
      MEMPALACE_MCP_ALLOW_PEER_WRITER: "1",
      mempalace_mcp_idle_hours: "0",
      MemPalace_Palace_Path: "C:\\mine",
      mempalace_config_dir: "C:\\mine",
    };
    const { dir, env } = throwaway("four", { root: made(), env: given });
    expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith("MEMPALACE_"))).toEqual(["MEMPALACE_CONFIG_DIR"]);
    expect(inside(dir, env.MEMPALACE_CONFIG_DIR ?? "")).toBe(true);
    expect(env.PATH).toBe("/bin");
  });

  it("leaves no API key, in any case", () => {
    const keys = Object.fromEntries(API_KEYS.flatMap((k) => [[k, "sk-1"], [k.toLowerCase(), "sk-2"]]));
    const { env } = throwaway("two", { root: made(), env: { PATH: "/bin", ...keys } });
    expect(Object.keys(env).filter((k) => API_KEYS.includes(k.toUpperCase()))).toEqual([]);
  });

  it("takes only a plain folder name", () => {
    const root = made();
    for (const name of ["..", "a/b", "a\\b", ""]) expect(() => throwaway(name, { root })).toThrow();
  });
});

describe("snapshot", () => {
  function tree(): string {
    const dir = made();
    mkdirSync(path.join(dir, "watched", "sub"), { recursive: true });
    writeFileSync(path.join(dir, "watched", "a.txt"), "one");
    writeFileSync(path.join(dir, "watched", "sub", "b.txt"), "two");
    return dir;
  }

  // The paths a comparison's lines name, sorted.
  const paths = (lines: string[]) => lines.map((l) => /(?:changed|added|removed) (\S+)/.exec(l)?.[1]).toSorted();

  it("finds no change in a folder left alone", () => {
    const dir = tree();
    const folders = { watched: path.join(dir, "watched") };
    expect(compare(snapshot(folders), snapshot(folders))).toEqual({ changes: [], apart: [] });
  });

  it("reports a file changed, added or removed", () => {
    const dir = tree();
    const folders = { watched: path.join(dir, "watched") };
    const before = snapshot(folders);
    writeFileSync(path.join(dir, "watched", "a.txt"), "one more");
    writeFileSync(path.join(dir, "watched", "sub", "c.txt"), "three");
    unlinkSync(path.join(dir, "watched", "sub", "b.txt"));
    const changes = compare(before, snapshot(folders)).changes.join("\n");
    expect(changes).toMatch(/changed.*a\.txt/);
    expect(changes).toMatch(/added.*c\.txt/);
    expect(changes).toMatch(/removed.*b\.txt/);
  });

  // The user's choice at step 1, "Set apart, still shown": the user's own MemPalace keeps writing these two places by
  // itself, so a change there is shown on its own but does not fail the comparison. Matched by exact path only.
  it("sets apart, still showing, changes in the user's own MemPalace's daemon folders and hook log only", () => {
    const dir = made();
    const home = path.join(dir, "mp");
    for (const sub of ["daemon/key1", "daemon/key1/deeper", "hook_state", "palace"]) {
      mkdirSync(path.join(home, sub), { recursive: true });
    }
    for (const file of ["daemon/key1/pid", "daemon/key1/deeper/x", "hook_state/hook.log", "hook_state/other.log"]) {
      writeFileSync(path.join(home, file), "1");
    }
    const folders = { "~/.mempalace": home, other: path.join(dir, "other") };
    mkdirSync(path.join(dir, "other", "daemon", "key1"), { recursive: true });
    writeFileSync(path.join(dir, "other", "daemon", "key1", "pid"), "1");
    const before = snapshot(folders);
    // Set apart: a daemon folder's own times, a file directly inside it, a new daemon folder, the hook log.
    writeFileSync(path.join(home, "daemon", "key1", "pid"), "22");
    writeFileSync(path.join(home, "daemon", "key1", "new"), "1");
    mkdirSync(path.join(home, "daemon", "key2"));
    writeFileSync(path.join(home, "hook_state", "hook.log"), "22");
    // Still failing: anything else, deeper inside a daemon folder, beside the hook log, the same names elsewhere.
    writeFileSync(path.join(home, "daemon", "key1", "deeper", "x"), "22");
    writeFileSync(path.join(home, "hook_state", "other.log"), "22");
    writeFileSync(path.join(home, "hook_state", "new.log"), "1");
    writeFileSync(path.join(home, "palace", "new"), "1");
    writeFileSync(path.join(home, "daemon.txt"), "1");
    writeFileSync(path.join(dir, "other", "daemon", "key1", "pid"), "22");
    const { changes, apart }: { changes: string[]; apart: string[] } = compare(before, snapshot(folders));
    // A new daemon folder and a new file beside the hook log change daemon's and hook_state's own times: set apart.
    expect(paths(apart)).toEqual([
      "daemon",
      "daemon/key1",
      "daemon/key1/new",
      "daemon/key1/pid",
      "daemon/key2",
      "hook_state",
      "hook_state/hook.log",
    ]);
    expect(apart.every((l) => l.startsWith("~/.mempalace: "))).toBe(true);
    // Exactly these fail, and no line for the set-apart places is among them.
    expect(paths(changes)).toEqual([
      "daemon.txt",
      "daemon/key1/deeper/x",
      "daemon/key1/pid",
      "hook_state/new.log",
      "hook_state/other.log",
      "palace",
      "palace/new",
    ]);
    expect(changes.filter((l) => !l.startsWith("~/.mempalace: "))).toEqual([
      expect.stringMatching(/^other: changed daemon\/key1\/pid /),
    ]);
  });

  it("sets apart a daemon folder added or removed and the hook log made again, failing nothing", () => {
    const dir = made();
    const home = path.join(dir, "mp");
    for (const sub of ["daemon/key1", "daemon/key3", "hook_state"]) {
      mkdirSync(path.join(home, sub), { recursive: true });
    }
    for (const file of ["daemon/key1/pid", "daemon/key3/pid", "hook_state/hook.log"]) {
      writeFileSync(path.join(home, file), "1");
    }
    const folders = { "~/.mempalace": home };
    const before = snapshot(folders);
    mkdirSync(path.join(home, "daemon", "key2"));
    writeFileSync(path.join(home, "daemon", "key2", "pid"), "1");
    unlinkSync(path.join(home, "daemon", "key3", "pid"));
    rmdirSync(path.join(home, "daemon", "key3"));
    unlinkSync(path.join(home, "hook_state", "hook.log"));
    writeFileSync(path.join(home, "hook_state", "hook.log"), "1");
    const { changes, apart }: { changes: string[]; apart: string[] } = compare(before, snapshot(folders));
    expect(changes).toEqual([]);
    expect(paths(apart)).toEqual([
      "daemon",
      "daemon/key2",
      "daemon/key2/pid",
      "daemon/key3",
      "daemon/key3/pid",
      "hook_state",
      "hook_state/hook.log",
    ]);
    expect(apart.join("\n")).toMatch(/added daemon\/key2/);
    expect(apart.join("\n")).toMatch(/removed daemon\/key3/);
  });

  it("records a missing folder as missing, and reports it appearing", () => {
    const dir = made();
    const folders = { gone: path.join(dir, "gone") };
    const before = snapshot(folders);
    expect(before.gone).toMatchObject({ missing: true });
    mkdirSync(path.join(dir, "gone"));
    expect(compare(before, snapshot(folders)).changes.join("\n")).toMatch(/gone/);
  });

  it("lists a link without following it", () => {
    const dir = tree();
    mkdirSync(path.join(dir, "outside"));
    writeFileSync(path.join(dir, "outside", "secret.txt"), "x");
    symlinkSync(path.join(dir, "outside"), path.join(dir, "watched", "away"), "junction");
    const snap = snapshot({ watched: path.join(dir, "watched") });
    const names = Object.keys(snap.watched?.entries ?? {});
    expect(names.some((n) => n.startsWith("away"))).toBe(true);
    expect(names.some((n) => n.includes("secret"))).toBe(false);
  });

  // A folder's own access time is left out: listing a folder sets it where the system keeps access times (measured on
  // the build PC, whose NTFS has last-access updates on), as any listing of it does.
  it("leaves the files' change and access details as they were", () => {
    const dir = tree();
    const files = ["watched", "watched/a.txt", "watched/sub", "watched/sub/b.txt"].map((f) => path.join(dir, f));
    const old = new Date("2020-01-02T03:04:05Z");
    for (const f of files) utimesSync(f, old, old);
    const details = () => files.map((f) => {
      const s = lstatSync(f);
      return [s.isDirectory() ? "folder" : s.atimeMs, s.mtimeMs, s.ctimeMs, s.size];
    });
    const before = details();
    snapshot({ watched: path.join(dir, "watched") });
    expect(details()).toEqual(before);
  });

  it("saves its result inside the folder given, under a plain name only", () => {
    const root = made();
    const snap = snapshot({ gone: path.join(root, "gone") });
    const file = saveSnapshot("first", snap, root);
    expect(inside(root, file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(snap);
    expect(() => saveSnapshot("../out", snap, root)).toThrow();
  });
});
