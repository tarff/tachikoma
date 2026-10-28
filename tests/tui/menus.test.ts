import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandMenu, listFolder, pathMenu } from "../../src/tui/menus.js";
import { tempContext } from "../helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const labels = (m: ReturnType<typeof commandMenu>) => m?.entries.map((e) => e.label);

describe("commandMenu", () => {
  it("lists every command for a slash at the start of the prompt, each saying what it does", () => {
    const m = commandMenu("/", 1);
    expect(labels(m)).toEqual([
      ...["/lead <provider:model>", "/model", "/login chatgpt", "/logout chatgpt", "/tasks", "/errors", "/screen"],
      ...["/settings", "/keybindings", "/exit"],
    ]);
    expect(m!.entries[0]).toMatchObject({ note: "Switch the lead model", fill: "/lead ", run: "/lead" });
    expect(m!.entries[7]).toMatchObject({ note: "Open the settings file in your editor", fill: "/settings ", run: "/settings" });
    expect(m!.entries[8]).toMatchObject({ note: "Open the keys file in your editor", fill: "/keybindings ", run: "/keybindings" });
  });

  it("narrows as the command is typed, in any case", () => {
    expect(labels(commandMenu("/lo", 3))).toEqual(["/login chatgpt", "/logout chatgpt"]);
    expect(labels(commandMenu("/LOGO", 5))).toEqual(["/logout chatgpt"]);
  });

  it("is closed for a message, after a space, away from the start, or with the cursor before the end", () => {
    expect(commandMenu("/tmp", 4)).toBeNull();
    expect(commandMenu("/lead x", 7)).toBeNull();
    expect(commandMenu("x /l", 4)).toBeNull();
    expect(commandMenu("/le", 1)).toBeNull();
    expect(commandMenu("", 0)).toBeNull();
  });
});

describe("pathMenu", () => {
  const list = (folder: string) =>
    folder === "src/" ? { entries: [{ name: "x.ts", folder: false }] } : folder === "" ? { entries: [{ name: "src", folder: true }, { name: "a.txt", folder: false }, { name: "Sub", folder: true }] } : { error: `ENOENT ${folder}` };

  it("lists the project folder for @ at the start or after a space, folders ending in /", () => {
    for (const text of ["@", "read @"]) {
      const m = pathMenu(text, text.length, list);
      expect(labels(m)).toEqual(["src/", "a.txt", "Sub/"]);
      expect(m!.from).toBe(text.length - 1);
    }
    expect(pathMenu("a@", 2, list)).toBeNull();
  });

  it("narrows by the name being typed, in any case, and lists the folder typed so far", () => {
    expect(labels(pathMenu("@s", 2, list))).toEqual(["src/", "Sub/"]);
    expect(pathMenu("@s", 2, list)!.entries[1]!.fill).toBe("@Sub/");
    const m = pathMenu("@src/", 5, list);
    expect(labels(m)).toEqual(["src/x.ts"]);
    expect(m!.entries[0]!.fill).toBe("@src/x.ts ");
    expect(pathMenu("@zz", 3, list)).toBeNull();
  });

  it("says why a folder cannot be listed", () => {
    expect(pathMenu("@nope/", 6, list)!.entries).toEqual([{ label: "Cannot list nope/: ENOENT nope/", fill: "", error: true }]);
  });
});

describe("listFolder", () => {
  it("lists folders first, then files, each by name", async () => {
    const { root } = await tempContext();
    await mkdir(path.join(root, "b"));
    await mkdir(path.join(root, "a"));
    await writeFile(path.join(root, "c.txt"), "");
    await writeFile(path.join(root, "0.txt"), "");
    expect(listFolder(root, "")).toEqual({
      entries: [
        { name: "a", folder: true },
        { name: "b", folder: true },
        { name: "0.txt", folder: false },
        { name: "c.txt", folder: false },
      ],
    });
  });

  it("never lists Tachikoma's data folder or what is in it, as the file tools never touch it", async () => {
    const { root } = await tempContext();
    const data = path.join(root, "data");
    await mkdir(data);
    await writeFile(path.join(data, "chatgpt.json"), "{}");
    await writeFile(path.join(root, "kept.txt"), "");
    vi.stubEnv("TACHI_DATA_DIR", data);
    expect(listFolder(root, "")).toEqual({ entries: [{ name: "kept.txt", folder: false }] });
    expect(listFolder(root, "data/")).toEqual({ error: expect.stringContaining("Tachikoma's data folder") });
  });

  it("gives the reason a folder cannot be listed", async () => {
    const { root } = await tempContext();
    expect(listFolder(root, "nope/")).toEqual({ error: expect.stringContaining("ENOENT") });
  });
});
