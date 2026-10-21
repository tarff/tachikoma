import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

describe("file tools", () => {
  it("writes, then reads back", async () => {
    const ctx = await tempContext();
    await writeFileTool.run({ path: "sub/a.txt", content: "hello" }, ctx);
    expect(await readFileTool.run({ path: "sub/a.txt" }, ctx)).toBe("hello");
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
