import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { API_KEYS, commandEnv, onPath } from "../../src/exec/env.js";
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

  // The CI trial: under PowerShell 7, Windows PowerShell started from tachi took 7's modules and could not load Get-Acl.
  it("leaves out on Windows a PSModulePath showing PowerShell 7, in any case, and passes any other on untouched", () => {
    const own = "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules;D:\\mine\\Modules;;";
    for (const seven of [
      "C:\\Users\\me\\OneDrive\\Documents\\PowerShell\\Modules",
      "C:\\Program Files\\PowerShell\\Modules",
      "c:\\program files\\powershell\\7\\Modules",
      "C:\\Program Files\\PowerShell\\7-preview\\Modules\\",
      "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.4.0_x64__8wekyb3d8bbwe\\Modules",
      "C:\\Program Files\\WindowsApps\\Microsoft.PowerShellPreview_7.6.0.0_arm64__8wekyb3d8bbwe\\Modules",
    ]) {
      expect(commandEnv({ PATH: "C:\\bin", PSModulePath: `${seven};${own}` }, "win32")).toEqual({ PATH: "C:\\bin" });
      expect(commandEnv({ psmodulepath: `${own};${seven}` }, "win32")).toEqual({});
      expect(commandEnv({ PSModulePath: seven }, "linux")).toEqual({ PSModulePath: seven });
    }
    expect(commandEnv({ PSModulePath: own }, "win32")).toEqual({ PSModulePath: own });
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
