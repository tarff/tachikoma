import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    writeFileSync(path.join(home, "palace", "new"), "1");
    writeFileSync(path.join(home, "daemon.txt"), "1");
    writeFileSync(path.join(dir, "other", "daemon", "key1", "pid"), "22");
    const { changes, apart }: { changes: string[]; apart: string[] } = compare(before, snapshot(folders));
    const paths = (lines: string[]) => lines.map((l) => /(?:changed|added|removed) (\S+)/.exec(l)?.[1]).toSorted();
    const setApart = ["daemon/key1", "daemon/key1/new", "daemon/key1/pid", "daemon/key2", "hook_state/hook.log"];
    expect(paths(apart)).toEqual(setApart);
    expect(apart.every((l) => l.startsWith("~/.mempalace: "))).toBe(true);
    const failing = paths(changes.filter((l) => l.startsWith("~/.mempalace: ")));
    for (const p of setApart) expect(failing).not.toContain(p);
    expect(changes.join("\n")).toMatch(/~\/\.mempalace: changed daemon\/key1\/deeper\/x/);
    expect(changes.join("\n")).toMatch(/~\/\.mempalace: changed hook_state\/other\.log/);
    expect(changes.join("\n")).toMatch(/~\/\.mempalace: added palace\/new/);
    expect(changes.join("\n")).toMatch(/~\/\.mempalace: added daemon\.txt/);
    expect(changes.join("\n")).toMatch(/other: changed daemon\/key1\/pid/);
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
