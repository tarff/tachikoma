import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { projectFile } from "../../src/core/datadir.js";
import { answersFor } from "../../src/mcp/answers.js";
import { removeTree } from "../helpers.js";

// Release 8c plan, choice 24: the project's answers to "use this project's MCP server?", one line per answer, each holding
// the entry it was given for (ServerConfig.written; any text stands in for one here). Making the data folder's own
// folder private starts PowerShell on Windows.
describe("answersFor", { timeout: 15_000 }, () => {
  const A = "entry-a";
  const B = "entry-b";
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
    expect(answers.get("sanity", A)).toBeUndefined();
    answers.set("sanity", A, true);
    expect(answers.get("sanity", A)).toBe(true);
    expect(answersFor(root, data).get("sanity", A)).toBe(true);
    answers.set("sanity", A, false);
    answers.set("figma", B, true);
    expect(answers.get("sanity", A)).toBe(false);
    expect(answersFor(root, data).get("sanity", A)).toBe(false);
    answers.reset("sanity");
    expect(answers.get("sanity", A)).toBeUndefined();
    const again = answersFor(root, data);
    expect(again.get("sanity", A)).toBeUndefined();
    expect(again.get("figma", B)).toBe(true);
    expect(readFileSync(file, "utf8").split("\n")).toEqual([
      `{"name":"sanity","entry":"${A}","yes":true}`,
      `{"name":"sanity","entry":"${A}","yes":false}`,
      `{"name":"figma","entry":"${B}","yes":true}`,
      '{"name":"sanity","reset":true}',
      "",
    ]);
  });

  // A git pull that changes a server's entry must not start it on the old yes.
  it("gives no answer for an entry other than the one answered, until that one is answered; a reset clears both", () => {
    const { data, root } = folders();
    const answers = answersFor(root, data);
    answers.set("sanity", A, true);
    expect(answers.get("sanity", B)).toBeUndefined();
    expect(answersFor(root, data).get("sanity", B)).toBeUndefined();
    answers.set("sanity", B, true);
    expect(answers.get("sanity", B)).toBe(true);
    expect(answersFor(root, data).get("sanity", B)).toBe(true);
    expect(answersFor(root, data).get("sanity", A)).toBeUndefined(); // the last line for a name wins, whatever its entry
    answers.reset("sanity");
    for (const entry of [A, B]) {
      expect(answers.get("sanity", entry)).toBeUndefined();
      expect(answersFor(root, data).get("sanity", entry)).toBeUndefined();
    }
  });

  it("skips a damaged line, keeping the ones around it", () => {
    const { data, root, file } = folders();
    answersFor(root, data).set("sanity", A, true);
    const lines = [
      `{"name":"figma","entry":"${A}","yes":true`,
      `{"name":"figma","entry":"${A}","yes":"no"}`,
      `{"name":7,"entry":"${A}","yes":false}`,
      '{"name":"figma","yes":true}',
      `{"name":"figma","entry":7,"yes":true}`,
      "[]",
      '{"name":"sanity"}',
    ];
    writeFileSync(file, `${readFileSync(file, "utf8")}${lines.join("\n")}\n{"name":"openmarket","entry":"${A}","yes":false}\n`);
    const answers = answersFor(root, data);
    expect(answers.get("sanity", A)).toBe(true);
    expect(answers.get("figma", A)).toBeUndefined();
    expect(answers.get("openmarket", A)).toBe(false);
  });

  it("takes a line with a yes and a reset of false as that yes", () => {
    const { data, root, file } = folders();
    answersFor(root, data).set("sanity", A, false);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"name":"sanity","entry":"${A}","yes":true,"reset":false}\n`);
    expect(answersFor(root, data).get("sanity", A)).toBe(true);
  });

  // As the transcript's mend: a half-written last line would otherwise swallow the next answer.
  it("ends a half-written last line before the next answer", () => {
    const { data, root, file } = folders();
    answersFor(root, data).set("sanity", A, true);
    writeFileSync(file, `${readFileSync(file, "utf8")}{"name":"a","entry":"${A}","yes":tr`);
    answersFor(root, data).set("b", A, true);
    const answers = answersFor(root, data);
    expect(answers.get("b", A)).toBe(true);
    expect(answers.get("sanity", A)).toBe(true);
    expect(answers.get("a", A)).toBeUndefined();
  });

  // On Windows a file others can read needs its permissions changed to set up, so this runs elsewhere only: there a
  // file the test makes with the usual mode, 0o644 after the usual umask, can be read by others.
  it("passes readPrivate's note that it made the file private to warn", (ctx) => {
    if (process.platform === "win32") return ctx.skip("outside Windows only: setting it up on Windows changes permissions");
    const { data, root, file } = folders();
    answersFor(root, data).set("sanity", A, true);
    const text = readFileSync(file, "utf8");
    rmSync(file);
    writeFileSync(file, text, { mode: 0o644 });
    const said: string[] = [];
    expect(answersFor(root, data, (m) => said.push(m)).get("sanity", A)).toBe(true);
    expect(said).toEqual([`${file} could be read by others; it is now private to you.`]);
  });

  it("writes nothing, not even its folder, until an answer is given", () => {
    const { data, root, file } = folders();
    expect(answersFor(root, data).get("sanity", A)).toBeUndefined();
    expect(existsSync(path.dirname(file))).toBe(false);
  });

  // Release 8c plan, choice 50: an answer that cannot be written still holds for this launch, and the write's failure is
  // thrown for the launch to say; choice 52: a reset that cannot be written leaves the answer in force, as the file the
  // next launch reads still holds it. A file stands where the answers' folder goes; no permission is changed.
  it("keeps an answer for this launch when it cannot be written, keeps it when its reset cannot be, and throws", () => {
    const { data, root, file } = folders();
    const answers = answersFor(root, data);
    mkdirSync(data, { recursive: true });
    writeFileSync(path.dirname(file), "a file where the answers' folder goes");
    expect(() => answers.set("sanity", A, true)).toThrow();
    expect(answers.get("sanity", A)).toBe(true);
    expect(() => answers.reset("sanity")).toThrow();
    expect(answers.get("sanity", A)).toBe(true);
  });
});
