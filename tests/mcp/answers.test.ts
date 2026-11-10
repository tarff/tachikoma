import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { projectFile } from "../../src/core/datadir.js";
import { answersFor } from "../../src/mcp/answers.js";
import { removeTree } from "../helpers.js";

// Release 8c plan, choice 24: the project's answers to "use this project's MCP server?", one line per answer. Making the
// data folder's own folder private starts PowerShell on Windows.
describe("answersFor", { timeout: 15_000 }, () => {
  // A data folder and a project folder of the test's own.
  function folders() {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-answers-"));
    onTestFinished(() => removeTree(dir));
    const data = path.join(dir, "data");
    const root = path.join(dir, "project");
    mkdirSync(root);
    return { data, root, file: projectFile("mcp-answers", root, data) };
  }

  it("keeps yes, then no, then a reset, the last line for a name winning, for the next answersFor too", () => {
    const { data, root, file } = folders();
    const answers = answersFor(root, data);
    expect(answers.get("sanity")).toBeUndefined();
    answers.set("sanity", true);
    expect(answers.get("sanity")).toBe(true);
    expect(answersFor(root, data).get("sanity")).toBe(true);
    answers.set("sanity", false);
    answers.set("figma", true);
    expect(answers.get("sanity")).toBe(false);
    expect(answersFor(root, data).get("sanity")).toBe(false);
    answers.reset("sanity");
    expect(answers.get("sanity")).toBeUndefined();
    const again = answersFor(root, data);
    expect(again.get("sanity")).toBeUndefined();
    expect(again.get("figma")).toBe(true);
    expect(readFileSync(file, "utf8").split("\n")).toEqual([
      '{"name":"sanity","yes":true}',
      '{"name":"sanity","yes":false}',
      '{"name":"figma","yes":true}',
      '{"name":"sanity","reset":true}',
      "",
    ]);
  });

  it("skips a damaged line, keeping the ones around it", () => {
    const { data, root, file } = folders();
    answersFor(root, data).set("sanity", true);
    const lines = ['{"name":"figma","yes":true', '{"name":"figma","yes":"no"}', '{"name":7,"yes":false}', "[]", '{"name":"sanity"}'];
    writeFileSync(file, `${readFileSync(file, "utf8")}${lines.join("\n")}\n{"name":"openmarket","yes":false}\n`);
    const answers = answersFor(root, data);
    expect(answers.get("sanity")).toBe(true);
    expect(answers.get("figma")).toBeUndefined();
    expect(answers.get("openmarket")).toBe(false);
  });

  it("writes nothing, not even its folder, until an answer is given", () => {
    const { data, root, file } = folders();
    expect(answersFor(root, data).get("sanity")).toBeUndefined();
    expect(existsSync(path.dirname(file))).toBe(false);
  });
});
