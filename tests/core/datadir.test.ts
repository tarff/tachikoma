import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir } from "../../src/core/datadir.js";

describe("dataDir", () => {
  it("is the folder the design names on each system", () => {
    expect(dataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32", "C:\\Users\\u")).toBe(path.join("C:\\Users\\u\\AppData\\Local", "tachikoma"));
    expect(dataDir({}, "darwin", "/Users/u")).toBe(path.join("/Users/u", "Library", "Application Support", "tachikoma"));
    expect(dataDir({}, "linux", "/home/u")).toBe(path.join("/home/u", ".local", "share", "tachikoma"));
  });

  it("can be moved with TACHI_DATA_DIR", () => {
    expect(dataDir({ TACHI_DATA_DIR: "/tmp/t" }, "linux", "/home/u")).toBe("/tmp/t");
  });
});
