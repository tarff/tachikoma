import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "../../src/core/permissions.js";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { editFileTool, programEnvironment, readFileTool, resolveIn, writeFileTool } from "../../src/tools/files.js";
import { shortName, tempContext } from "../helpers.js";

describe("resolveIn", () => {
  it("marks paths that leave the project", () => {
    const root = path.resolve("/proj");
    expect(resolveIn(root, "a/b.txt").outside).toBe(false);
    expect(resolveIn(root, "../x").outside).toBe(true);
    expect(resolveIn(root, path.resolve("/elsewhere/x")).outside).toBe(true);
    expect(resolveIn(root, "..foo").outside).toBe(false); // a file named "..foo" is inside
  });
});

describe("a program's environment, on Linux", () => {
  it("is found by its real path, a thread's included", () => {
    expect(programEnvironment("/proc/1234/environ")).toBe(true);
    expect(programEnvironment("/proc/1234/task/1235/environ")).toBe(true);
    expect(programEnvironment("/proc/1234/cmdline")).toBe(false);
    expect(programEnvironment("/home/me/proc/1234/environ")).toBe(false);
  });

  it.runIf(process.platform === "linux")("is refused after following /proc/self", () => {
    expect(() => resolveIn("/tmp", "/proc/self/environ")).toThrow("/proc/self/environ is a program's environment, which can hold API keys, so the file tools never read it");
  });
});

describe("the data folder", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The project itself holds the data folder here, so `never` mode would otherwise allow everything.
  async function setup() {
    const ctx = await tempContext("never");
    const data = path.join(ctx.root, "data");
    await mkdir(data);
    await writeFile(path.join(data, "chatgpt.json"), "{}");
    vi.stubEnv("TACHI_DATA_DIR", data);
    return ctx;
  }

  it("is refused to every file tool, even in never mode", async () => {
    const ctx = await setup();
    const refused = "is in Tachikoma's data folder, which the file tools never touch";
    await expect(readFileTool.run({ path: "data/chatgpt.json" }, ctx)).rejects.toThrow(refused);
    await expect(writeFileTool.run({ path: "data/new.json", content: "x" }, ctx)).rejects.toThrow(refused);
    await expect(editFileTool.run({ path: "data/chatgpt.json", old_text: "{}", new_text: "[]" }, ctx)).rejects.toThrow(refused);
    await expect(readFileTool.run({ path: "data" }, ctx)).rejects.toThrow(refused);
    expect(await readFile(path.join(ctx.root, "data", "chatgpt.json"), "utf8")).toBe("{}");
  });

  it("is refused through a link too", async () => {
    const ctx = await setup();
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    await symlink(path.join(ctx.root, "data"), path.join(ctx.root, "innocent"), "junction");
    await expect(readFileTool.run({ path: "innocent/chatgpt.json" }, ctx)).rejects.toThrow("Tachikoma's data folder");
  });

  it("is refused through a hard link to one of its files", async () => {
    const ctx = await setup();
    linkSync(path.join(ctx.root, "data", "chatgpt.json"), path.join(ctx.root, "innocent.json"));
    await expect(readFileTool.run({ path: "innocent.json" }, ctx)).rejects.toThrow("Tachikoma's data folder");
    await expect(writeFileTool.run({ path: "innocent.json", content: "x" }, ctx)).rejects.toThrow("Tachikoma's data folder");
    expect(await readFile(path.join(ctx.root, "data", "chatgpt.json"), "utf8")).toBe("{}");
    // Other hard-linked files, as a pnpm project is full of, are still read.
    await writeFile(path.join(ctx.root, "a.txt"), "fine");
    linkSync(path.join(ctx.root, "a.txt"), path.join(ctx.root, "b.txt"));
    expect(await readFileTool.run({ path: "b.txt" }, ctx)).toBe("     1\tfine");
  });

  // Windows reaches one folder by its short name (TACHIK~1), by \\?\ and by the loopback share
  // \\localhost\C$, and macOS ignores case. Each spelling that reaches the file on this machine is tried.
  it.runIf(process.platform === "win32" || process.platform === "darwin")("is refused by every spelling that reaches it", async () => {
    const ctx = await tempContext("never");
    const data = path.join(ctx.root, "tachikoma");
    await mkdir(data);
    await writeFile(path.join(data, "chatgpt.json"), "{}");
    vi.stubEnv("TACHI_DATA_DIR", data);
    const file = path.join(data, "chatgpt.json");
    const spellings = [path.join(ctx.root, "TACHIKOMA", "chatgpt.json")];
    if (process.platform === "win32") {
      const short = /(\S+~\d+)\s+tachikoma\s*$/im.exec(execFileSync("cmd", ["/c", "dir", "/x", ctx.root], { encoding: "utf8" }))?.[1];
      if (short) spellings.push(path.join(ctx.root, short, "chatgpt.json"));
      spellings.push(`\\\\?\\${file}`, `\\\\localhost\\${file[0]}$${file.slice(2)}`);
    }
    const reaching = spellings.filter((p) => existsSync(p));
    expect(reaching.length).toBeGreaterThan(0);
    for (const p of reaching) {
      await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow("Tachikoma's data folder");
      await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow("Tachikoma's data folder");
    }
    expect(await readFile(file, "utf8")).toBe("{}");
  });

  // Windows cannot stat a drive's root spelled \\?\C:\ (EISDIR), which the walk up from a \\?\ path reaches.
  it.runIf(process.platform === "win32")("reads and writes a long path (\\\\?\\) outside it, once it exists", async () => {
    const ctx = await tempContext("never");
    await mkdir(path.join(ctx.root, "tachikoma"));
    vi.stubEnv("TACHI_DATA_DIR", path.join(ctx.root, "tachikoma"));
    const file = `\\\\?\\${path.join(ctx.root, "a.txt")}`;
    await writeFileTool.run({ path: file, content: "fine" }, ctx);
    expect(await readFileTool.run({ path: file }, ctx)).toBe("     1\tfine");
  });

  it("leaves a folder whose name only starts the same alone", async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.root, "data2.txt"), "fine");
    expect(await readFileTool.run({ path: "data2.txt" }, ctx)).toBe("     1\tfine");
  });
});

describe("the settings and keys files", () => {
  afterEach(() => vi.unstubAllEnvs());

  // The project is the test's home folder, so ~/.tachikoma is inside it, where `project` and `never`
  // mode would otherwise let the model rewrite the files unasked.
  async function home(mode: Mode, names = ["settings.json", "keybindings.json", "settings.json.lock", "errors.jsonl"]) {
    const ctx = await tempContext(mode);
    vi.stubEnv("USERPROFILE", ctx.root);
    vi.stubEnv("HOME", ctx.root);
    await mkdir(path.join(ctx.root, ".tachikoma"));
    for (const name of names) await writeFile(path.join(ctx.root, ".tachikoma", name), "{}");
    return ctx;
  }
  const refused = (abs: string) => `${abs} is one of Tachikoma's settings files, which the file tools never touch; edit it with /settings or /keybindings`;

  it.each(["ask", "project", "never"] as const)("are refused to read, write and edit in %s mode, a save's lock and temporary files too", async (mode) => {
    const ctx = await home(mode);
    for (const name of ["settings.json", "keybindings.json", "settings.json.lock", "settings.json.1234.0a1b2c3d.tmp"]) {
      const p = path.join(".tachikoma", name);
      const message = refused(path.join(ctx.root, p));
      await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow(message);
      await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow(message);
      await expect(editFileTool.run({ path: p, old_text: "{}", new_text: "[]" }, ctx)).rejects.toThrow(message);
    }
    expect(ctx.asked).toEqual([]);
    for (const name of ["settings.json", "keybindings.json", "settings.json.lock"]) {
      expect(await readFile(path.join(ctx.root, ".tachikoma", name), "utf8")).toBe("{}");
    }
    expect(existsSync(path.join(ctx.root, ".tachikoma", "settings.json.1234.0a1b2c3d.tmp"))).toBe(false);
  });

  // Windows gives each a short name on a volume that makes them (SETTIN~1.JSO), and the real path keeps
  // that spelling, so only what the file is shows it is one of them. The folder's short name too.
  it.for(["ask", "project", "never"] as const)("are refused by their short names in %s mode", async (mode, { skip }) => {
    const ctx = await home(mode);
    const folder = path.join(ctx.root, ".tachikoma");
    const short = ["settings.json", "keybindings.json", "settings.json.lock"].map((name) => shortName(folder, name));
    const shortFolder = shortName(ctx.root, ".tachikoma");
    if (!shortFolder || short.some((s) => !s)) skip("this system or volume makes no short names");
    for (const p of [...short.map((s) => path.join(".tachikoma", s!)), path.join(shortFolder!, short[0]!)]) {
      const message = refused(path.join(ctx.root, p));
      await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow(message);
      await expect(editFileTool.run({ path: p, old_text: "{}", new_text: "[]" }, ctx)).rejects.toThrow(message);
      await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow(message);
    }
    expect(ctx.asked).toEqual([]);
    for (const name of ["settings.json", "keybindings.json", "settings.json.lock"]) {
      expect(await readFile(path.join(folder, name), "utf8")).toBe("{}");
    }
  });

  // An editor saving the keys file can leave companions beside it, as a settings save does.
  it("refuse the keys file's companions too", async () => {
    const ctx = await home("never", ["keybindings.json.bak"]);
    for (const name of ["keybindings.json.bak", "keybindings.json.1234.0a1b2c3d.tmp"]) {
      const p = path.join(".tachikoma", name);
      await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
      await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    }
    expect(await readFile(path.join(ctx.root, ".tachikoma", "keybindings.json.bak"), "utf8")).toBe("{}");
    expect(existsSync(path.join(ctx.root, ".tachikoma", "keybindings.json.1234.0a1b2c3d.tmp"))).toBe(false);
  });

  it("are refused before they exist, so a write cannot make them", async () => {
    const ctx = await tempContext("never");
    vi.stubEnv("USERPROFILE", ctx.root);
    vi.stubEnv("HOME", ctx.root);
    for (const name of ["settings.json", "keybindings.json"]) {
      const p = path.join(".tachikoma", name);
      await expect(writeFileTool.run({ path: p, content: "{}" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    }
    expect(existsSync(path.join(ctx.root, ".tachikoma"))).toBe(false);
  });

  it.each(["ask", "project", "never"] as const)("are refused through a link to their folder, and through a hard link to one, in %s mode", async (mode) => {
    const ctx = await home(mode);
    await symlink(path.join(ctx.root, ".tachikoma"), path.join(ctx.root, "innocent"), "junction");
    const p = path.join("innocent", "settings.json");
    await expect(readFileTool.run({ path: p }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    await expect(editFileTool.run({ path: p, old_text: "{}", new_text: "[]" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    linkSync(path.join(ctx.root, ".tachikoma", "keybindings.json"), path.join(ctx.root, "innocent.json"));
    await expect(readFileTool.run({ path: "innocent.json" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, "innocent.json")));
    await expect(writeFileTool.run({ path: "innocent.json", content: "x" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, "innocent.json")));
    expect(await readFile(path.join(ctx.root, ".tachikoma", "settings.json"), "utf8")).toBe("{}");
    expect(await readFile(path.join(ctx.root, ".tachikoma", "keybindings.json"), "utf8")).toBe("{}");
    expect(ctx.asked).toEqual([]);
  });

  // Windows and macOS ignore case, and Windows drops dots at the end of a name, so these reach the same
  // files. A path inside one would make it a folder.
  it("are refused by other spellings of their names, and to a path inside one", async () => {
    const ctx = await home("never", []);
    for (const p of ["SETTINGS.JSON", "settings.json.", "Keybindings.Json", path.join("settings.json", "x")].map((n) => path.join(".tachikoma", n))) {
      await expect(writeFileTool.run({ path: p, content: "{}" }, ctx)).rejects.toThrow(refused(path.join(ctx.root, p)));
    }
    expect(readdirSync(path.join(ctx.root, ".tachikoma"))).toEqual([]);
  });

  // Windows reaches one folder by \\?\ and by the loopback share \\localhost\C$, and macOS ignores case.
  it.runIf(process.platform === "win32" || process.platform === "darwin")("are refused by every spelling of their folder that reaches it", async () => {
    const ctx = await home("never");
    const file = path.join(ctx.root, ".tachikoma", "settings.json");
    const spellings = [path.join(ctx.root, ".TACHIKOMA", "settings.json")];
    if (process.platform === "win32") spellings.push(`\\\\?\\${file}`, `\\\\localhost\\${file[0]}$${file.slice(2)}`);
    const reaching = spellings.filter((p) => existsSync(p));
    expect(reaching.length).toBeGreaterThan(0);
    for (const p of reaching) await expect(writeFileTool.run({ path: p, content: "x" }, ctx)).rejects.toThrow(refused(path.resolve(p)));
    expect(await readFile(file, "utf8")).toBe("{}");
  });

  it("leave the folder's other files, and settings files elsewhere, alone", async () => {
    const ctx = await home("never");
    await mkdir(path.join(ctx.root, "project", ".tachikoma"), { recursive: true });
    for (const p of [".tachikoma/errors.jsonl", ".tachikoma/settings.json5", ".tachikoma/old-settings.json", "project/.tachikoma/settings.json"]) {
      await writeFileTool.run({ path: p, content: "fine" }, ctx);
      expect(await readFileTool.run({ path: p }, ctx)).toBe("     1\tfine");
    }
  });
});

describe("file tools", () => {
  it("writes, then reads back", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "sub/a.txt", content: "hello" }, ctx);
    expect(await readFileTool.run({ path: "sub/a.txt" }, ctx)).toBe("     1\thello");
  });

  it("numbers the lines it reads, and reads a part when given offset and limit", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "a.txt"), "one\r\ntwo\nthree\n");
    expect(await readFileTool.run({ path: "a.txt" }, ctx)).toBe("     1\tone\n     2\ttwo\n     3\tthree");
    expect(await readFileTool.run({ path: "a.txt", offset: 2, limit: 1 }, ctx)).toBe(
      "(showing lines 2-2 of 3; use offset and limit to read the rest)\n     2\ttwo",
    );
  });

  it("reads 2,000 lines unless told otherwise, saying so first, where a cut-off cannot hide it", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "a.txt"), Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join("\n"));
    const out = await readFileTool.run({ path: "a.txt" }, ctx);
    expect(out.split("\n")[0]).toBe("(showing lines 1-2000 of 2500; use offset and limit to read the rest)");
    expect(out).toContain("  2000\tl2000");
    expect(out).not.toContain("l2001");
  });

  it("says how long a file is when asked to start past its end, and when it is empty", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "a.txt"), "one\ntwo\n");
    await writeFile(path.join(ctx.root, "empty.txt"), "");
    expect(await readFileTool.run({ path: "a.txt", offset: 5 }, ctx)).toBe("(a.txt has 2 lines)");
    expect(await readFileTool.run({ path: "empty.txt" }, ctx)).toBe("(empty.txt is empty)");
  });

  it("shows what a write or an edit will put in the file when asking", async () => {
    const ctx = await tempContext("ask", [true, true]);
    await writeFileTool.run({ path: "a.txt", content: "one\ntwo" }, ctx);
    await editFileTool.run({ path: "a.txt", old_text: "one\ntwo", new_text: "three" }, ctx);
    expect(ctx.details).toEqual(["one\ntwo", "- one\n- two\n+ three"]);
  });

  it("edits one unique match", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "one two three" }, ctx);
    await editFileTool.run({ path: "a.txt", old_text: "two", new_text: "$&2" }, ctx);
    expect(await readFile(path.join(ctx.root, "a.txt"), "utf8")).toBe("one $&2 three");
  });

  it("refuses an edit that matches nothing or more than once", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "x x" }, ctx);
    await expect(editFileTool.run({ path: "a.txt", old_text: "y", new_text: "z" }, ctx)).rejects.toThrow("was not found");
    await expect(editFileTool.run({ path: "a.txt", old_text: "x", new_text: "z" }, ctx)).rejects.toThrow("appears 2 times");
  });

  it("rejects input that does not match the schema", async () => {
    const ctx = await tempContext();
    await expect(writeFileTool.run({ path: "a.txt" }, ctx)).rejects.toThrow("Invalid input for write_file");
  });

  it("asks before writing outside the project in project mode", async () => {
    const ctx = await tempContext("project", [false]);
    await expect(writeFileTool.run({ path: "../escape.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(1);
  });

  it("treats a path through a link that leads out of the project as outside", async () => {
    const ctx = await tempContext("project", [false]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    // A junction needs no special rights on Windows; on other systems this makes a directory symlink.
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    expect(resolveIn(ctx.root, "linked/x.txt").outside).toBe(true);
    await expect(writeFileTool.run({ path: "linked/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(1);
  });

  it("shows where a path through a link really leads when asking", async () => {
    const ctx = await tempContext("project", [false]);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "tachi-outside-"));
    await symlink(elsewhere, path.join(ctx.root, "linked"), "junction");
    await expect(writeFileTool.run({ path: "linked/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked[0]).toContain(`(really ${path.join(realpathSync(elsewhere), "x.txt")})`);
  });

  it("treats a link that leads nowhere as outside", async () => {
    // A write through it could create its missing target, wherever that is.
    const ctx = await tempContext("project", [false]);
    const missing = path.join(tmpdir(), `tachi-missing-${process.pid}-${Date.now()}`);
    await symlink(missing, path.join(ctx.root, "dangling"), "junction");
    expect(resolveIn(ctx.root, "dangling/x.txt").outside).toBe(true);
    await expect(writeFileTool.run({ path: "dangling/x.txt", content: "x" }, ctx)).rejects.toThrow("The user declined");
  });

  it("asks before reading or editing a file outside the project, given by absolute path", async () => {
    const ctx = await tempContext("project", [false, false]);
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "tachi-outside-")), "a.txt");
    await writeFile(outside, "one");
    await expect(readFileTool.run({ path: outside }, ctx)).rejects.toThrow("The user declined");
    await expect(editFileTool.run({ path: outside, old_text: "one", new_text: "two" }, ctx)).rejects.toThrow("The user declined");
    expect(ctx.asked).toHaveLength(2);
    expect(await readFile(outside, "utf8")).toBe("one");
  });

  it("refuses to edit a file that is not UTF-8 text, leaving it unchanged", async () => {
    const ctx = await tempContext();
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6f, 0x6c, 0x64]); // "café old" in Latin-1
    await writeFile(path.join(ctx.root, "a.txt"), latin1);
    await expect(editFileTool.run({ path: "a.txt", old_text: "old", new_text: "new" }, ctx)).rejects.toThrow("not UTF-8 text");
    expect(await readFile(path.join(ctx.root, "a.txt"))).toEqual(latin1);
  });

  it("reads \\n in an edit as \\r\\n in a file with Windows line endings, which read_file does not show", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "a.txt", content: "one\r\ntwo\r\n" }, ctx);
    await editFileTool.run({ path: "a.txt", old_text: "one\ntwo", new_text: "un\ndeux" }, ctx);
    expect(await readFile(path.join(ctx.root, "a.txt"), "utf8")).toBe("un\r\ndeux\r\n");
  });

  it("matches the text as sent first, so a file that mixes line endings can be edited in either part", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "m.txt"), "a\r\nb\r\nc\nd\ne\n");
    await editFileTool.run({ path: "m.txt", old_text: "c\nd", new_text: "x\ny" }, ctx);
    await editFileTool.run({ path: "m.txt", old_text: "a\nb", new_text: "p\nq" }, ctx);
    expect(await readFile(path.join(ctx.root, "m.txt"), "utf8")).toBe("p\r\nq\r\nx\ny\ne\n");
  });

  it("checks an edit inside the project before asking, so the user is not asked about one that cannot work", async () => {
    const ctx = await tempContext("ask", [true]);
    await writeFile(path.join(ctx.root, "a.txt"), "one");
    await expect(editFileTool.run({ path: "a.txt", old_text: "three", new_text: "x" }, ctx)).rejects.toThrow("old_text was not found");
    expect(ctx.asked).toEqual([]);
  });

  it("gives a whole file that fits under the output limit in one piece, with no note", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "a.txt"), Array.from({ length: 10 }, () => "x".repeat(2991)).join("\n"));
    const out = await readFileTool.run({ path: "a.txt" }, ctx);
    expect(out.startsWith("(showing")).toBe(false);
    expect(out).toHaveLength(29_989); // just under MAX_TOOL_OUTPUT, closer than any note would leave room for
  });

  it("stops reading before the output limit, and names the last line it really shows", async () => {
    const ctx = await tempContext();
    await writeFile(path.join(ctx.root, "a.txt"), Array.from({ length: 2500 }, (_, i) => `${i + 1} ${"x".repeat(100)}`).join("\n"));
    const out = await readFileTool.run({ path: "a.txt" }, ctx);
    const last = Number(/^\(showing lines 1-(\d+) of 2500;/.exec(out)![1]);
    expect(last).toBeLessThan(2000);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT);
    expect(out.split("\n").at(-1)).toMatch(new RegExp(`^ *${last}\\t${last} x`));
  });

  it("treats a new file in a new folder inside the project as inside", async () => {
    const ctx = await tempContext();
    await mkdir(path.join(ctx.root, "real"));
    expect(resolveIn(ctx.root, "real/new/deeper/x.txt").outside).toBe(false);
  });

  it("writes inside the project without asking in project mode", async () => {
    const ctx = await tempContext("project");
    await writeFileTool.run({ path: "a.txt", content: "x" }, ctx);
    expect(ctx.asked).toEqual([]);
  });
});
