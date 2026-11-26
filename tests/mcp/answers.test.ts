import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectFile } from "../../src/core/datadir.js";
import { answersFor, launchAnswers } from "../../src/mcp/answers.js";
import { tempDir } from "../helpers.js";

// Release 8c plan, choice 24: the project's answers to "use this project's MCP server?", one line per answer, each holding
// the entry it was given for (ServerConfig.written; any text stands in for one here). Making the data folder's own
// folder private starts PowerShell on Windows.
describe("answersFor", { timeout: 15_000 }, () => {
  const A = "entry-a";
  const B = "entry-b";
  // A data folder and a project folder of the test's own.
  function folders() {
    const dir = tempDir("tachi-answers-");
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

  // 8c-2a plan, Task 2 (decision 11): an answer holds the setup it was given for, and counts for that setup only, so a
  // yes for the box never starts the server on this computer, nor in live link or with the network on.
  it("gives an answer for its own setup only, for the next answersFor too", () => {
    const { data, root, file } = folders();
    const answers = answersFor(root, data);
    answers.set("sanity", A, true, "box copy network off");
    for (const a of [answers, answersFor(root, data)]) {
      expect(a.get("sanity", A, "box copy network off")).toBe(true);
      for (const setup of ["host", "box copy network on", "box live network off", "box live network on", undefined]) {
        expect(a.get("sanity", A, setup)).toBeUndefined();
      }
    }
    expect(readFileSync(file, "utf8")).toBe(
      `{"name":"sanity","entry":"${A}","yes":true,"setup":"box copy network off"}\n`,
    );
  });

  // Choice 2 (b): going back to a setup already answered asks nothing; /mcp's Reset my answer forgets them all.
  it("keeps one answer per setup, and a reset forgets every one", () => {
    const { data, root } = folders();
    const answers = answersFor(root, data);
    answers.set("sanity", A, true, "host");
    for (const a of [answers, answersFor(root, data)]) {
      expect(a.get("sanity", A, "box live network on")).toBeUndefined(); // a host yes is no answer for the box
      expect(a.get("sanity", A)).toBeUndefined(); // nor for none
    }
    answers.set("sanity", A, false, "box copy network off");
    answers.set("figma", A, true, "helper");
    for (const a of [answers, answersFor(root, data)]) {
      expect(a.get("sanity", A, "host")).toBe(true);
      expect(a.get("sanity", A, "box copy network off")).toBe(false);
      expect(a.get("figma", A, "helper")).toBe(true);
      expect(a.get("figma", A, "no helper")).toBeUndefined();
    }
    answers.reset("sanity");
    for (const a of [answers, answersFor(root, data)]) {
      expect(a.get("sanity", A, "host")).toBeUndefined();
      expect(a.get("sanity", A, "box copy network off")).toBeUndefined();
      expect(a.get("figma", A, "helper")).toBe(true);
    }
  });

  // Decision 11: 8c ran every server on this computer, so its lines, which have no setup, count for `host` and for
  // none, never for the box or a helper; a `host` answer given since wins over one.
  it("counts a line without a setup for host and for none only, until a host answer is given", () => {
    const { data, root, file } = folders();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `{"name":"sanity","entry":"${A}","yes":true}\n`);
    const answers = answersFor(root, data);
    expect(answers.get("sanity", A, "host")).toBe(true);
    expect(answers.get("sanity", A)).toBe(true);
    for (const setup of ["box copy network off", "box live network on", "helper", "no helper"]) {
      expect(answers.get("sanity", A, setup)).toBeUndefined();
    }
    answers.set("sanity", A, false, "host");
    for (const a of [answers, answersFor(root, data)]) {
      expect(a.get("sanity", A, "host")).toBe(false);
      expect(a.get("sanity", A)).toBe(true);
    }
    answers.set("sanity", B, true, "host");
    expect(answers.get("sanity", A, "host")).toBeUndefined(); // the host answer is for another entry: no falling back
    expect(answersFor(root, data).get("sanity", A, "host")).toBeUndefined();
  });
});

// 8c-2a plan, Task 2: the launch's own answers keep their setups as the project's file does.
describe("launchAnswers", () => {
  it("keeps one answer per setup, counts one without a setup for host, and a reset forgets every one", () => {
    const answers = launchAnswers();
    answers.set("sanity", "entry-a", true, "box copy network off");
    expect(answers.get("sanity", "entry-a", "box copy network off")).toBe(true);
    for (const setup of ["host", "box copy network on", "box live network off", "box live network on", undefined]) {
      expect(answers.get("sanity", "entry-a", setup)).toBeUndefined();
    }
    answers.set("sanity", "entry-a", false);
    expect(answers.get("sanity", "entry-a")).toBe(false);
    expect(answers.get("sanity", "entry-a", "host")).toBe(false);
    expect(answers.get("sanity", "entry-a", "helper")).toBeUndefined();
    answers.set("sanity", "entry-a", true, "host");
    expect(answers.get("sanity", "entry-a", "host")).toBe(true);
    expect(answers.get("sanity", "entry-a")).toBe(false);
    expect(answers.get("sanity", "entry-a", "box copy network off")).toBe(true);
    answers.reset("sanity");
    for (const setup of ["host", "box copy network off", undefined]) {
      expect(answers.get("sanity", "entry-a", setup)).toBeUndefined();
    }
  });
});
