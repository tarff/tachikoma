import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { PROTECTED_FILES, PROTECTED_FOLDERS, protectedPart } from "../../src/safety/protected.js";

// A made-up project folder that does not exist, so its real place is itself.
const root = path.resolve("/tachi-protected-test/project");
const at = (...parts: string[]) => path.join(root, ...parts);
const windows = process.platform === "win32";
// Each system's path rules, with a made-up project folder in that system's spelling, so another system's matching can
// be tested here.
const SYSTEMS: [NodeJS.Platform, path.PlatformPath, string][] = [
  ["win32", path.win32, "C:\\tachi-protected-test\\project"],
  ["darwin", path.posix, "/tachi-protected-test/project"],
  ["linux", path.posix, "/tachi-protected-test/project"],
];

// The design's lists ("Protected paths"), and lefthook's files per choice 10.
const FOLDERS = [".git", ".config/git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn", ".claude", ".tachikoma"];
const LEFTHOOK = ["lefthook.yml", "lefthook.yaml", "lefthook.json", "lefthook.toml"];
const FILES = [
  ".gitconfig", ".gitmodules",
  ".bashrc", ".bash_profile", ".bash_login", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".envrc",
  ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnp.cjs", ".pnp.loader.mjs", ".pnpmfile.cjs", "bunfig.toml", ".bunfig.toml",
  ".bazelrc", ".bazelversion", ".bazeliskrc",
  ".pre-commit-config.yaml", ...LEFTHOOK, ...LEFTHOOK.map((name) => `.${name}`), "lefthook-local.*", ".lefthook-local.*",
  "gradle-wrapper.properties", "maven-wrapper.properties",
  ".devcontainer.json", ".ripgreprc", "pyrightconfig.json", ".mcp.json", ".claude.json",
];
// The plain names, and names lefthook-local.* stands for.
const NAMED = [...FILES.filter((name) => !name.endsWith("*")), "lefthook-local.yml", ".lefthook-local.json", "lefthook-local.yml.bak"];

describe("the protected lists", () => {
  it("are the design's", () => {
    expect(PROTECTED_FOLDERS).toEqual(FOLDERS);
    expect(PROTECTED_FILES).toEqual(FILES);
  });
});

describe("protectedPart", () => {
  it("finds each folder at the top and deeper, as the path spells it", () => {
    for (const folder of FOLDERS) {
      const part = path.join(...folder.split("/"));
      expect(protectedPart(root, at(part, "hooks", "pre-commit"), [], [])).toBe(part);
      expect(protectedPart(root, at("web", "app", part, "settings.json"), [], [])).toBe(part);
      expect(protectedPart(root, at("web", part), [], [])).toBe(part);
    }
  });

  it("finds each file at the top and deeper", () => {
    for (const name of NAMED) {
      expect(protectedPart(root, at(name), [], [])).toBe(name);
      expect(protectedPart(root, at("tools", "sub", name), [], [])).toBe(name);
    }
  });

  it("ignores case on Windows and macOS, not on Linux (choice 60)", () => {
    for (const [platform, rules, top] of SYSTEMS) {
      const ignores = platform !== "linux";
      const cases: [string, string][] = [
        [rules.join(top, ".HUSKY", "pre-commit"), ".HUSKY"],
        [rules.join(top, "web", ".Config", "GIT", "config"), rules.join(".Config", "GIT")],
        [rules.join(top, "TOOLS", ".NPMRC"), ".NPMRC"],
        [rules.join(top, "LEFTHOOK-LOCAL.YML"), "LEFTHOOK-LOCAL.YML"],
      ];
      for (const [real, part] of cases) expect(protectedPart(top, real, [], [], platform)).toBe(ignores ? part : undefined);
      const hooks = rules.join(top, "tools", "hooks");
      const file = rules.join(top, "shared", "team.gitconfig");
      expect(protectedPart(top, rules.join(top, "TOOLS", "Hooks", "x"), [hooks], [], platform)).toBe(ignores ? hooks : undefined);
      expect(protectedPart(top, rules.join(top, "Shared", "TEAM.gitconfig"), [], [file], platform)).toBe(ignores ? file : undefined);
      expect(protectedPart(top, rules.join(top.toUpperCase(), ".npmrc"), [], [], platform)).toBe(ignores ? ".npmrc" : undefined);
    }
  });

  it("drops a part's trailing dots and spaces and a :stream on Windows only, as Windows does (choice 60)", () => {
    const [, w, top] = SYSTEMS[0]!;
    const hooks = w.join(top, "tools", "hooks");
    const file = w.join(top, "shared", "team.gitconfig");
    const cases: [string, string | undefined][] = [
      [w.join(top, "tools", ".npmrc."), ".npmrc."],
      [w.join(top, "tools", ".npmrc :x"), ".npmrc :x"],
      [w.join(top, ".npmrc:x:$DATA"), ".npmrc:x:$DATA"],
      [w.join(top, ".husky .", "pre-commit"), ".husky ."],
      [w.join(top, ".config.", "git ", "config"), w.join(".config.", "git ")],
      [w.join(top, "lefthook-local.yml."), "lefthook-local.yml."],
      [w.join(top, "tools", ".npmrc.bak"), undefined],
      [w.join(top, "lefthook-local."), undefined],
    ];
    for (const [real, part] of cases) expect(protectedPart(top, real, [], [], "win32")).toBe(part);
    expect(protectedPart(top, w.join(top, "tools", "hooks.", "pre-commit"), [hooks], [], "win32")).toBe(hooks);
    expect(protectedPart(top, w.join(top, "shared", "team.gitconfig. "), [], [file], "win32")).toBe(file);
    // Elsewhere a trailing dot is part of the name.
    const [, p, posixTop] = SYSTEMS[2]!;
    expect(protectedPart(posixTop, p.join(posixTop, "tools", ".npmrc."), [], [], "linux")).toBeUndefined();
    expect(protectedPart(posixTop, p.join(posixTop, ".husky .", "pre-commit"), [], [], "darwin")).toBeUndefined();
    expect(protectedPart(posixTop, p.join(posixTop, "tools", "hooks.", "x"), [p.join(posixTop, "tools", "hooks")], [], "darwin")).toBeUndefined();
  });

  it("passes over near misses", () => {
    for (const real of [
      at("gitignore"),
      at("my.npmrc.bak"),
      at(".gitignore"),
      at("src", ".npmrc", "x"), // a file's name counts only as the last part
      at(".config", "other", "x"),
      at(".config", "x", "git"),
      at("git", ".config", "x"),
      at("lefthook-local"),
      at("my-lefthook-local.yml"),
      at("web", "my.git", "x"),
    ]) {
      expect(protectedPart(root, real, [], [])).toBeUndefined();
    }
  });

  it("finds a path inside a hooks folder, with the folder as the part", () => {
    const hooks = at("tools", "hooks");
    expect(protectedPart(root, at("tools", "hooks", "pre-commit"), [hooks], [])).toBe(hooks);
    expect(protectedPart(root, at("tools", "hooks", "sub", "x"), [hooks], [])).toBe(hooks);
    expect(protectedPart(root, hooks, [hooks], [])).toBe(hooks);
    expect(protectedPart(root, at("tools", "hooks-old", "pre-commit"), [hooks], [])).toBeUndefined();
    expect(protectedPart(root, at("TOOLS", "Hooks", "pre-commit"), [hooks], [])).toBe(windows ? hooks : undefined);
  });

  it("finds a path inside a git folder kept elsewhere in the project (choice 59)", () => {
    const gitDir = at("modules", "lib.git");
    expect(protectedPart(root, at("modules", "lib.git", "hooks", "post-checkout"), [gitDir], [])).toBe(gitDir);
  });

  it("finds a path that is one of git's settings files, with that path as the part (choice 57)", () => {
    const include = at("shared", "team.gitconfig");
    expect(protectedPart(root, include, [], [include])).toBe(include);
    expect(protectedPart(root, at("SHARED", "Team.gitconfig"), [], [include])).toBe(windows ? include : undefined);
    expect(protectedPart(root, at("shared", "team.gitconfig.bak"), [], [include])).toBeUndefined();
    expect(protectedPart(root, at("shared", "other"), [], [include])).toBeUndefined();
  });

  it("gives undefined for a path outside the project, whatever it is", () => {
    const elsewhere = path.resolve("/tachi-protected-test/elsewhere");
    const hooks = path.join(elsewhere, "hooks");
    const file = path.join(elsewhere, "git.inc");
    expect(protectedPart(root, path.join(elsewhere, ".npmrc"), [], [])).toBeUndefined();
    expect(protectedPart(root, path.join(elsewhere, ".husky", "pre-commit"), [], [])).toBeUndefined();
    expect(protectedPart(root, path.join(hooks, "pre-commit"), [hooks], [])).toBeUndefined();
    expect(protectedPart(root, file, [], [file])).toBeUndefined();
    expect(protectedPart(root, path.resolve("/tachi-protected-test/project-other/.npmrc"), [], [])).toBeUndefined();
  });

  it("names nothing for the project's own folder", () => {
    expect(protectedPart(root, root, [], [])).toBeUndefined();
  });

  it("compares with the project's real place, as resolveIn does, when the project is reached through a link", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tachi-protected-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "real"));
    symlinkSync(path.join(dir, "real"), path.join(dir, "joined"), "junction");
    const real = realpathSync.native(path.join(dir, "real"));
    expect(protectedPart(path.join(dir, "joined"), path.join(real, "tools", ".npmrc"), [], [])).toBe(".npmrc");
    expect(protectedPart(path.join(dir, "joined"), path.join(real, "src", "app.ts"), [], [])).toBeUndefined();
  });
});
