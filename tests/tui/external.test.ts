import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { commandEnv, system32 } from "../../src/exec/env.js";
import { editFile, editorCommand, editText, NOT_FOUND, type Runner } from "../../src/tui/external.js";
import { InputFilter } from "../../src/tui/input.js";
import { TerminalOwner } from "../../src/tui/owner.js";
import { standInEditor } from "../helpers.js";

// The real shell, recording each call's arguments: the temporary file's path is in them.
function recorded() {
  const calls: { file: string; args: string[]; options: object }[] = [];
  const run: Runner = (file, args, options) => {
    calls.push({ file, args, options });
    return new Promise((resolve, reject) => {
      spawn(file, args, options)
        .on("error", reject)
        .on("exit", (code, signal) => resolve({ code, signal }));
    });
  };
  // The temporary file, as the shell's command line names it in quotes (src/tui/external.ts).
  const temp = () => /"([^"]*prompt\.md)"/.exec(calls.at(-1)!.args.join(" "))![1]!;
  return { run, calls, temp };
}

describe("editorCommand", () => {
  const NOTEPAD = system32("notepad.exe");

  it("takes VISUAL, then EDITOR, then the settings' editor, then Notepad on Windows or vi elsewhere", () => {
    expect(editorCommand({ VISUAL: "v" }, undefined, "win32")).toBe("v");
    expect(editorCommand({ EDITOR: "e" }, undefined, "win32")).toBe("e");
    expect(editorCommand({}, "code --wait", "win32")).toBe("code --wait");
    expect(editorCommand({}, undefined, "win32")).toBe(NOTEPAD);
    expect(editorCommand({}, undefined, "linux")).toBe("vi");
    expect(editorCommand({ VISUAL: "v", EDITOR: "e" }, "s", "linux")).toBe("v");
    expect(editorCommand({ EDITOR: "e" }, "s", "linux")).toBe("e");
  });

  it("passes over an empty variable or setting", () => {
    expect(editorCommand({ VISUAL: "", EDITOR: "e" }, undefined, "linux")).toBe("e");
    expect(editorCommand({ VISUAL: "", EDITOR: "" }, "s", "linux")).toBe("s");
    expect(editorCommand({ VISUAL: "", EDITOR: "" }, "", "linux")).toBe("vi");
  });
});

// These run the shell for real (cmd.exe here), with the stand-in in a folder whose name has a space.
describe("editText", () => {
  it("gives the editor the text in prompt.md, and returns what it saved, its temporary folder gone after", async () => {
    const editor = standInEditor();
    editor.next("after\nthe edit\n");
    const { run, temp } = recorded();
    expect(await editText("before", editor.command("keep"), run)).toEqual({ text: "after\nthe edit" });
    expect(editor.given()).toEqual({ file: temp(), text: "before" });
    expect(path.basename(temp())).toBe("prompt.md");
    expect(existsSync(path.dirname(temp()))).toBe(false);
  });

  it.each([
    { name: "two line breaks", saved: "a\n\n", text: "a\n" },
    { name: "Windows' line break", saved: "a\r\n", text: "a" },
    { name: "none", saved: "a", text: "a" },
  ])("drops one trailing line break only: $name", async ({ saved, text }) => {
    const editor = standInEditor();
    editor.next(saved);
    expect(await editText("", editor.command("keep"))).toEqual({ text });
  });

  it("says the exit code of an editor that fails, its temporary folder gone after", async () => {
    const editor = standInEditor();
    const { run, temp } = recorded();
    expect(await editText("x", editor.command("fail"), run)).toEqual({ failed: "exit code 1" });
    expect(existsSync(temp())).toBe(false);
    expect(existsSync(path.dirname(temp()))).toBe(false);
  });

  // cmd.exe prints its own "is not recognized" line to the inherited stderr.
  it("reads the shell's exit for a command it cannot find as not found, its temporary folder gone after", async () => {
    const { run, temp } = recorded();
    expect(await editText("x", "tachi-no-such-editor", run)).toEqual({ failed: NOT_FOUND });
    expect(existsSync(path.dirname(temp()))).toBe(false);
  });
});

describe("editFile", () => {
  it("opens the file in place, and says the exit code of an editor that fails", async () => {
    const editor = standInEditor();
    const { run, calls } = recorded();
    const file = path.join(editor.dir, "settings.json");
    writeFileSync(file, "{}\n");
    editor.next('{"mode": "project"}\n');
    expect(await editFile(file, editor.command("keep"), run)).toEqual({ ok: true });
    expect(editor.given()).toEqual({ file, text: "{}\n" });
    expect(readFileSync(file, "utf8")).toBe('{"mode": "project"}\n');
    expect(calls).toHaveLength(1);
    expect(await editFile(file, editor.command("fail"), run)).toEqual({ failed: "exit code 1" });
  });
});

describe("the editor's run", () => {
  it("gets the terminal (stdio inherited) and the environment commands get, without the API keys", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    onTestFinished(() => void vi.unstubAllEnvs());
    const seen: Parameters<Runner>[] = [];
    const run: Runner = async (...call) => {
      seen.push(call);
      return { code: 0, signal: null };
    };
    await editText("x", "ed", run);
    await editFile("C:\\some file.json", "ed --wait", run);
    expect(seen).toHaveLength(2);
    for (const [, , options] of seen) {
      expect(options.stdio).toBe("inherit");
      expect(options.env).toEqual(commandEnv());
      expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    }
    // Choice 4: through the shell, the entry and then the file's path in quotes; on Windows `& exit`, so cmd's exit is
    // the editor's.
    if (process.platform === "win32") {
      expect(seen[1]!.slice(0, 2)).toEqual([system32("cmd.exe"), ["/d", "/s", "/c", '"ed --wait "C:\\some file.json" & exit"']]);
      expect(seen[1]![2].windowsVerbatimArguments).toBe(true);
    } else expect(seen[1]!.slice(0, 2)).toEqual(["/bin/sh", ["-c", 'ed --wait "$1"', "sh", "C:\\some file.json"]]);
  });

  // Release 6 plan, Task 12, test 5: an editor that runs in the terminal reads the keys itself. The test cannot type
  // into the terminal the editor inherits, so its runner gives the line on a pipe, as the terminal would; meanwhile a
  // key typed at the stand-in terminal reaches neither Ink's reads nor the filter's data.
  it("lets the keyboard go to an editor in the terminal, so no key reaches Ink meanwhile, and takes it back after", async () => {
    const source = Object.assign(new EventEmitter(), {
      setRawMode: () => source,
      setEncoding: () => source,
      pause: () => source,
      resume: () => source,
      ref: () => source,
      unref: () => source,
    });
    const filter = new InputFilter(source as never);
    const reads: string[] = [];
    const data: string[] = [];
    filter.on("readable", () => {
      let s: string | null;
      while ((s = filter.read()) !== null) reads.push(s);
    });
    filter.on("data", (d: string) => data.push(d));
    const owner = new TerminalOwner({
      suspend: async () => ({ resume: async () => {} }),
      hold: (on) => filter.hold(on),
      divert: (to) => filter.divert(to),
      release: () => filter.release(),
      retake: () => filter.retake(),
    });
    const run: Runner = (file, args, options) => {
      expect(options.stdio).toBe("inherit");
      const child = spawn(file, args, { ...options, stdio: ["pipe", "inherit", "inherit"] });
      source.emit("data", "typed while away");
      expect(source.listenerCount("data")).toBe(0);
      child.stdin!.end("the line\n");
      return new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    };
    const editor = standInEditor();
    expect(await owner.program(() => editText("before", editor.command("line"), run))).toEqual({ text: "the line" });
    expect([reads, data]).toEqual([[], []]);
    source.emit("data", "k");
    expect([reads, data]).toEqual([["k"], ["k"]]);
  });
});
