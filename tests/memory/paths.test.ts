import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectFile } from "../../src/core/datadir.js";
import {
  LESSONS,
  SHIPPED_LOCK,
  WING,
  lockHash,
  makeMemoryFolder,
  memoryPaths,
  roomName,
} from "../../src/memory/paths.js";

// MemPalace 3.12.0's rules for a room's name, written from the build record's step 6 item 10 (config.py:36-37,
// :137-162, run on 22 names), not from the code under test: at most 128 characters, counted as Python counts them
// (code points); the first and the last a letter or a digit of any script; between them letters, digits, `_`, space,
// `.`, `'` and `-`; no `..`, `/` or `\`.
function validRoom(room: string): boolean {
  const chars = [...room];
  const letterOrDigit = (c: string) => /^[\p{L}\p{N}]$/u.test(c);
  return (
    chars.length >= 1 &&
    chars.length <= 128 &&
    letterOrDigit(chars[0]!) &&
    letterOrDigit(chars.at(-1)!) &&
    chars.every((c) => letterOrDigit(c) || "_ .'-".includes(c)) &&
    !room.includes("..") &&
    !room.includes("/") &&
    !room.includes("\\")
  );
}

const inside = (file: string, folder: string) => {
  const rel = path.relative(folder, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

// A folder of the test's own, so the rooms are worked out from real paths.
async function folders() {
  return realpathSync.native(await mkdtemp(path.join(tmpdir(), "tachi-room-")));
}
function folder(parent: string, ...names: string[]) {
  const dir = path.join(parent, ...names);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("the rule-checker", () => {
  // Step 6 item 10's own examples, so the checker is held to what MemPalace was seen to keep and refuse.
  it("keeps what MemPalace kept and refuses what it refused", () => {
    for (const kept of ["agent-harness-3f9a1c2b", "Agent Harness-3F9A1C2B", "caf\u00e9", "\u65e5\u672c\u8a9e-3f9a1c2b",
      "app.v2-3f9a1c2b", "lessons", "a".repeat(128)]) {
      expect(validRoom(kept), kept).toBe(true);
    }
    for (const refused of ["app_", "_app", ".app", "app-", "a(b", "a)b", "a+b", "a#b", "a@b", "a&b", "a,b", "a..b",
      "a/b", "a\\b", "a".repeat(129), ""]) {
      expect(validRoom(refused), refused).toBe(false);
    }
  });
});

describe("the room name", () => {
  it("is the folder's name, a hyphen and the first 8 hex of the SHA-256 of its real path", async () => {
    const dir = folder(await folders(), "tachikoma");
    const code = createHash("sha256").update(realpathSync.native(dir)).digest("hex").slice(0, 8);
    expect(roomName(dir)).toBe(`tachikoma-${code}`);
    expect(code).toMatch(/^[0-9a-f]{8}$/);
  });

  it("resolves the folder as projectFile does, so its code is the start of the project files' name", async () => {
    const dir = folder(await folders(), "a project");
    const named = path.basename(projectFile("errors", dir, "unused"), ".jsonl");
    expect(roomName(dir)).toBe(`a project-${named.slice(0, 8)}`);
  });

  it("gives two folders with the same name in different places different rooms", async () => {
    const base = await folders();
    const one = roomName(folder(base, "one", "app"));
    const two = roomName(folder(base, "two", "app"));
    expect(one).toMatch(/^app-[0-9a-f]{8}$/);
    expect(two).toMatch(/^app-[0-9a-f]{8}$/);
    expect(one).not.toBe(two);
  });

  it("gives the same folder the same room, letter for letter, however it is written", async () => {
    const base = await folders();
    const dir = folder(base, "Mixed Case");
    const room = roomName(dir);
    expect(roomName(dir)).toBe(room);
    expect(room.startsWith("Mixed Case-")).toBe(true);
    if (process.platform === "win32") expect(roomName(dir.toUpperCase())).toBe(room);
  });

  // projectFile gives one file for each of these forms too (measured at step 16's review), and the room matches it.
  it("gives the same room for the folder written with a trailing separator", async () => {
    const dir = folder(await folders(), "Mixed Case");
    const room = roomName(dir);
    for (const form of [`${dir}${path.sep}`, `${dir}/`]) {
      expect(roomName(form)).toBe(room);
      expect(projectFile("x", form, "data")).toBe(projectFile("x", dir, "data"));
    }
  });

  it.runIf(process.platform === "win32")("gives the same room for the folder with a lowercase drive", async () => {
    const dir = folder(await folders(), "Mixed Case");
    const lower = dir[0]!.toLowerCase() + dir.slice(1);
    expect(lower).not.toBe(dir);
    expect(roomName(lower)).toBe(roomName(dir));
    expect(projectFile("x", lower, "data")).toBe(projectFile("x", dir, "data"));
  });

  it("cuts a name of 200 characters to a room of exactly 128", async () => {
    const room = roomName(folder(await folders(), "n".repeat(200)));
    expect([...room].length).toBe(128);
    expect(room).toMatch(new RegExp(`^${"n".repeat(119)}-[0-9a-f]{8}$`));
    expect(validRoom(room)).toBe(true);
  });

  it("gives a room that passes MemPalace's rules for names it would refuse as they are", async () => {
    const base = await folders();
    const cases: [string, RegExp][] = [
      ["my(app)+v2#1,&@", /^my_app__v2_1___-[0-9a-f]{8}$/],
      [".config", /^config-[0-9a-f]{8}$/],
      ["a..b", /^a\.b-[0-9a-f]{8}$/],
      ["x....y", /^x\.y-[0-9a-f]{8}$/],
      ["!!!", /^[0-9a-f]{8}$/],
      ["_-'.lead", /^lead-[0-9a-f]{8}$/],
      [
        "\u65e5\u672c\u8a9e\u306e\u30d5\u30a9\u30eb\u30c0",
        /^\u65e5\u672c\u8a9e\u306e\u30d5\u30a9\u30eb\u30c0-[0-9a-f]{8}$/u,
      ],
      ["\u0928\u092e\u0938\u094d\u0924\u0947", /^\u0928\u092e\u0938_\u0924_-[0-9a-f]{8}$/u],
      ["\u0645\u0634\u0631\u0648\u0639", /^\u0645\u0634\u0631\u0648\u0639-[0-9a-f]{8}$/u],
    ];
    for (const [name, want] of cases) {
      const room = roomName(folder(base, name));
      expect(room, name).toMatch(want);
      expect(validRoom(room), room).toBe(true);
    }
  });

  it("counts a letter outside the Basic Multilingual Plane as one character, as Python does", async () => {
    // A CJK letter written as two UTF-16 units; 120 of them fit a Windows folder name (255 units).
    const letter = "\u{20000}";
    const room = roomName(folder(await folders(), letter.repeat(120)));
    expect([...room].length).toBe(128);
    expect(validRoom(room)).toBe(true);
  });

  it("is never the lessons room, whatever the folder is called", async () => {
    const base = await folders();
    for (const name of ["lessons", "Lessons", "lessons-", "---"]) {
      const room = roomName(folder(base, name));
      expect(room).not.toBe(LESSONS);
      expect(room).toMatch(/[0-9a-f]{8}$/);
      expect(validRoom(room)).toBe(true);
    }
    expect(LESSONS).toBe("lessons");
    expect(WING).toBe("tachikoma");
  });
});

describe("the lock file's hash", () => {
  it("is taken from the shipped memory/uv.lock, read with LF line endings, as the Dockerfile's tag is", async () => {
    expect(existsSync(SHIPPED_LOCK)).toBe(true);
    expect(path.basename(SHIPPED_LOCK)).toBe("uv.lock");
    const text = readFileSync(SHIPPED_LOCK, "latin1").replaceAll("\r\n", "\n");
    expect(lockHash()).toBe(createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex").slice(0, 12));
    const dir = await mkdtemp(path.join(tmpdir(), "tachi-lock-"));
    writeFileSync(path.join(dir, "lf.lock"), "a\nb\n");
    writeFileSync(path.join(dir, "crlf.lock"), "a\r\nb\r\n");
    writeFileSync(path.join(dir, "other.lock"), "a\nc\n");
    expect(lockHash(path.join(dir, "crlf.lock"))).toBe(lockHash(path.join(dir, "lf.lock")));
    expect(lockHash(path.join(dir, "other.lock"))).not.toBe(lockHash(path.join(dir, "lf.lock")));
    expect(lockHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("the memory folder", { timeout: 15_000 }, () => {
  afterEach(() => vi.unstubAllEnvs());

  it("holds every path inside the data folder given, under memory/", async () => {
    const data = path.join(tmpdir(), "tachi-data-not-made");
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const p = memoryPaths(data, "0123456789ab", platform);
      expect(p.root).toBe(path.join(data, "memory"));
      expect(p.env).toBe(path.join(data, "memory", "env", "0123456789ab"));
      expect(p.python).toBe(path.join(p.root, "python"));
      expect(p.uvCache).toBe(path.join(p.root, "uv-cache"));
      expect(p.home).toBe(path.join(p.root, "home"));
      expect(p.palace).toBe(path.join(p.root, "palace"));
      for (const [name, file] of Object.entries(p)) {
        if (name !== "root") expect(inside(file, p.root), `${name}: ${file}`).toBe(true);
      }
    }
    expect(existsSync(data)).toBe(false);
  });

  it("names the environment's own Python: Scripts\\python.exe on Windows, bin/python elsewhere", () => {
    const data = path.join(tmpdir(), "tachi-data-not-made");
    expect(memoryPaths(data, "0123456789ab", "win32").envPython).toBe(
      path.join(data, "memory", "env", "0123456789ab", "Scripts", "python.exe"),
    );
    for (const platform of ["linux", "darwin"] as const) {
      expect(memoryPaths(data, "0123456789ab", platform).envPython).toBe(
        path.join(data, "memory", "env", "0123456789ab", "bin", "python"),
      );
    }
  });

  it("uses the data folder and the shipped lock's hash when given neither", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "tachi-data-"));
    vi.stubEnv("TACHI_DATA_DIR", data);
    expect(memoryPaths().env).toBe(path.join(data, "memory", "env", lockHash()));
  });

  // privateDir runs on memory/ only, inside a data folder this test made (8d plan, step 16, "Permissions").
  it("makes memory/ as a plain folder inside the data folder, and nothing else", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "tachi-data-"));
    vi.stubEnv("TACHI_DATA_DIR", data);
    const p = memoryPaths();
    makeMemoryFolder(p);
    expect(lstatSync(p.root).isDirectory()).toBe(true);
    expect(path.dirname(p.root)).toBe(data);
    for (const name of ["python", "uv-cache", "env", "home", "palace"]) {
      expect(existsSync(path.join(p.root, name))).toBe(false);
    }
  });
});
