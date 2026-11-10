import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { API_KEYS, commandEnv, mcpProgram, onPath } from "../../src/exec/env.js";
import { PRESETS } from "../../src/providers/openai.js";

describe("commandEnv", () => {
  it("covers every key a provider reads", () => {
    const read = ["ANTHROPIC_API_KEY", ...Object.values(PRESETS).flatMap((p) => (p.keyEnv ? [p.keyEnv] : []))];
    expect(API_KEYS.toSorted()).toEqual(read.toSorted());
  });

  it("drops the API keys, in any case, and keeps everything else", () => {
    const env = commandEnv({ PATH: "/bin", OPENAI_API_KEY: "sk-1", openrouter_api_key: "sk-2", MY_API_KEY: "mine" });
    expect(env).toEqual({ PATH: "/bin", MY_API_KEY: "mine" });
  });

  // Release 7 plan, Task 8: bash's cd looks in CDPATH's folders first, so `cd sub` in a command could leave the project
  // where the dangerous-command check does not see.
  it("drops CDPATH, in any case", () => {
    expect(commandEnv({ PATH: "/bin", CDPATH: "/elsewhere", cdpath: "/other", CDPATHS: "kept" })).toEqual({ PATH: "/bin", CDPATHS: "kept" });
  });

  // A folder of the test's own, with the files named (empty, never run) in the folder `parts` names.
  function machine(parts: string[], files: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-psmodules-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, ...parts), { recursive: true });
    for (const file of files) writeFileSync(path.join(dir, ...parts, file), "");
    return (...at: string[]) => path.join(dir, ...at);
  }

  // The CI trial: under PowerShell 7, Windows PowerShell started from tachi took 7's modules and could not load Get-Acl.
  // PowerShell 7 shows by its own folder's Modules, beside pwsh.exe or pwsh.dll, whatever the folders are named; folders
  // with neither beside them, SQL Server's Tools\PowerShell\Modules and a PowerShell\7 among them, do not, nor does a
  // network path, which is not looked at (PR #11's outside review and its re-check).
  it("leaves out on Windows a PSModulePath listing PowerShell 7's own folder, in any case, and passes any other on untouched", () => {
    const at = machine(["scoop", "apps", "pwsh", "current"], ["pwsh.exe"]);
    mkdirSync(at("tool"));
    writeFileSync(at("tool", "pwsh.dll"), "");
    const sql = at("Microsoft SQL Server", "160", "Tools", "PowerShell", "Modules");
    const named = [at("WindowsPowerShell", "v1.0", "Modules"), sql, at("Documents", "PowerShell", "Modules"), at("PowerShell", "7", "Modules")];
    const own = [...named, "Modules", "", ""].join(";");
    const scoop = at("scoop", "apps", "pwsh", "current", "Modules");
    for (const listed of [scoop, at("scoop", "apps", "pwsh", "current", "modules") + path.sep, at("tool", "Modules")]) {
      expect(commandEnv({ PATH: "C:\\bin", PSModulePath: `${listed};${own}` }, "win32")).toEqual({ PATH: "C:\\bin" });
      expect(commandEnv({ psmodulepath: `${own};${listed}` }, "win32")).toEqual({});
      expect(commandEnv({ PSModulePath: listed }, "linux")).toEqual({ PSModulePath: listed });
    }
    for (const value of [own, sql, `\\\\?\\${scoop}`]) expect(commandEnv({ PSModulePath: value }, "win32")).toEqual({ PSModulePath: value });
  });

  // The user's choice, "Remember + skip shares": each look stats the disk.
  it("looks at a PSModulePath's folders once for each value, remembering the answer", () => {
    const at = machine(["pwsh"], ["pwsh.exe"]);
    const value = at("pwsh", "Modules");
    expect(commandEnv({ PSModulePath: value }, "win32")).toEqual({});
    rmSync(at("pwsh", "pwsh.exe"));
    expect(commandEnv({ PSModulePath: value }, "win32")).toEqual({});
    expect(commandEnv({ PSModulePath: `${value};` }, "win32")).toEqual({ PSModulePath: `${value};` });
  });
});

// The programs here are empty files the test made, looked for and never run.
describe("onPath", () => {
  const windows = process.platform === "win32";
  const exe = (name: string) => (windows ? `${name}.exe` : name);
  function folders(...names: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-onpath-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return names.map((name) => {
      mkdirSync(path.join(dir, name));
      return path.join(dir, name);
    });
  }

  it("takes the first folder on PATH holding the program, passing over empty and relative entries", () => {
    const [rel, none, first, second] = folders("rel", "none", "first", "second");
    for (const dir of [rel!, first!, second!]) writeFileSync(path.join(dir, exe("tool")), "");
    // `rel` holds the program too, but is written relative to the working folder. No relative path reaches it from
    // another drive, as on GitHub's Windows machines (the temporary folder on C:, the checkout on D:), so there it is
    // left out.
    const relative = path.relative(process.cwd(), rel!);
    const PATH = ["", ...(path.isAbsolute(relative) ? [] : [relative]), none, first, second].join(path.delimiter);
    expect(onPath("tool", { PATH })).toBe(path.join(first!, exe("tool")));
  });

  it("finds PATH in any case on Windows, and a folder in quotes", (ctx) => {
    if (!windows) return ctx.skip("Windows only: elsewhere a variable's name has its case");
    const [dir] = folders("quoted dir");
    writeFileSync(path.join(dir!, "tool.exe"), "");
    expect(onPath("tool", { Path: `"${dir}"` })).toBe(path.join(dir!, "tool.exe"));
  });

  it("follows the last PATH of two on Windows, as { ...process.env, PATH: x } overrides it", (ctx) => {
    if (!windows) return ctx.skip("Windows only: elsewhere Path and PATH are two variables");
    const [early, late] = folders("early", "late");
    writeFileSync(path.join(early!, "tool.exe"), "");
    writeFileSync(path.join(late!, "tool.exe"), "");
    expect(onPath("tool", { Path: early, PATH: late })).toBe(path.join(late!, "tool.exe"));
  });

  it("gives undefined when no folder holds it, a .cmd, a .bat or a folder of its name not counting", () => {
    const [dir] = folders("dir");
    if (windows) {
      writeFileSync(path.join(dir!, "tool.cmd"), "");
      writeFileSync(path.join(dir!, "tool.bat"), "");
    }
    mkdirSync(path.join(dir!, exe("tool")));
    expect(onPath("tool", { PATH: dir })).toBeUndefined();
    expect(onPath("tool", {})).toBeUndefined();
  });

  it("passes over a PATH entry that is a file, rather than failing", () => {
    const [dir, next] = folders("dir", "next");
    writeFileSync(path.join(dir!, "plain.txt"), "");
    writeFileSync(path.join(next!, exe("tool")), "");
    expect(onPath("tool", { PATH: [path.join(dir!, "plain.txt"), next].join(path.delimiter) })).toBe(path.join(next!, exe("tool")));
  });

  it("passes over a file that may not be run, outside Windows", (ctx) => {
    if (windows) return ctx.skip("Windows has no mark that lets a file be run");
    // A file made as usual cannot be run (Node's default mode, 0o666, has no run bit); no permission is changed.
    const [dir] = folders("dir");
    writeFileSync(path.join(dir!, "tool"), "");
    expect(onPath("tool", { PATH: dir })).toBeUndefined();
  });
});

// Release 8c plan, choice 4: an MCP server's program, by its full path, a .cmd such as npx's included. The programs are
// empty files the test made, looked for and never run.
describe("mcpProgram", () => {
  const windows = process.platform === "win32";
  function folders(...names: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-mcpprogram-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return names.map((name) => {
      mkdirSync(path.join(dir, name));
      return path.join(dir, name);
    });
  }
  const files = (dir: string, ...names: string[]) => names.forEach((name) => writeFileSync(path.join(dir, name), ""));

  it("finds npx.cmd for npx on Windows, .exe before .cmd when PATHEXT is unset", (ctx) => {
    if (!windows) return ctx.skip("Windows only: PATHEXT");
    const [first, second] = folders("first", "second");
    files(first!, "npx.cmd");
    files(second!, "npx.exe");
    expect(mcpProgram("npx", { PATH: [first, second].join(";") }, "win32")).toBe(path.join(first!, "npx.cmd"));
    files(first!, "npx.exe");
    expect(mcpProgram("npx", { PATH: [first, second].join(";") }, "win32")).toBe(path.join(first!, "npx.exe"));
    files(first!, "npx.com");
    expect(mcpProgram("npx", { PATH: first }, "win32")).toBe(path.join(first!, "npx.com"));
  });

  it("follows PATHEXT's order, in any case, and only its .com, .exe, .bat and .cmd", (ctx) => {
    if (!windows) return ctx.skip("Windows only: PATHEXT");
    const [dir] = folders("dir");
    files(dir!, "npx.exe", "npx.cmd", "npx.js");
    expect(mcpProgram("npx", { PATH: dir, PATHEXT: ".CMD;.EXE" }, "win32")).toBe(path.join(dir!, "npx.cmd"));
    expect(mcpProgram("npx", { Path: dir, pathext: ".JS;.Exe" }, "win32")).toBe(path.join(dir!, "npx.exe"));
  });

  it("looks for a name already ending in one of those endings as written, in any case", (ctx) => {
    if (!windows) return ctx.skip("Windows only: PATHEXT");
    const [dir] = folders("dir");
    // node.exe.EXE and npx.cmd.CMD are there too, so adding an ending would find them first.
    files(dir!, "node.exe", "node.exe.exe", "npx.cmd", "npx.cmd.cmd");
    expect(mcpProgram("node.exe", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(path.join(dir!, "node.exe"));
    expect(mcpProgram("npx.cmd", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32")).toBe(path.join(dir!, "npx.cmd"));
    expect(mcpProgram("NPX.CMD", { PATH: dir }, "win32")?.toLowerCase()).toBe(path.join(dir!, "npx.cmd").toLowerCase());
  });

  it("never finds a program in the working folder, by npx or npx.cmd, nor through a relative PATH entry", (ctx) => {
    if (!windows) return ctx.skip("Windows only: its own lookup starts in the working folder");
    const [project, empty] = folders("project", "empty");
    files(project!, "npx.cmd");
    const before = process.cwd();
    process.chdir(project!);
    try {
      for (const name of ["npx", "npx.cmd"]) expect(mcpProgram(name, { PATH: [empty, "", ".", "sub"].join(";") }, "win32")).toBeNull();
    } finally {
      process.chdir(before);
    }
  });

  it("passes over a relative PATH entry", () => {
    const [rel, next] = folders("rel", "next");
    const name = windows ? "tool.exe" : "tool";
    files(rel!, name);
    writeFileSync(path.join(next!, name), "", { mode: 0o755 }); // outside Windows, made so it may be run
    // As onPath's test: no relative path reaches another drive, so there `rel` is left out.
    const relative = path.relative(process.cwd(), rel!);
    const PATH = [...(path.isAbsolute(relative) ? [] : [relative]), next].join(path.delimiter);
    expect(mcpProgram("tool", { PATH })).toBe(path.join(next!, name));
  });

  it("takes a command with a folder in it as written, and gives null when nothing is found", () => {
    const [dir] = folders("dir");
    expect(mcpProgram(path.join("tools", "node"), { PATH: dir })).toBe(path.join("tools", "node"));
    expect(mcpProgram("./node", { PATH: dir })).toBe("./node");
    expect(mcpProgram("node", { PATH: dir })).toBeNull();
    expect(mcpProgram("node", {})).toBeNull();
  });
});
