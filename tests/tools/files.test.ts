import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TOOL_OUTPUT } from "../../src/exec/executor.js";
import { editFileTool, readFileTool, resolveIn, writeFileTool } from "../../src/tools/files.js";
import { tempContext } from "../helpers.js";

describe("resolveIn", () => {
  it("marks paths that leave the project", () => {
    const root = path.resolve("/proj");
    expect(resolveIn(root, "a/b.txt").outside).toBe(false);
    expect(resolveIn(root, "../x").outside).toBe(true);
    expect(resolveIn(root, path.resolve("/elsewhere/x")).outside).toBe(true);
    expect(resolveIn(root, "..foo").outside).toBe(false); // a file named "..foo" is inside
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

  it("leaves a folder whose name only starts the same alone", async () => {
    const ctx = await setup();
    await writeFile(path.join(ctx.root, "data2.txt"), "fine");
    expect(await readFileTool.run({ path: "data2.txt" }, ctx)).toBe("     1\tfine");
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
