import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { PROTECTED_FILES, PROTECTED_FOLDERS, protectedPart } from "../../src/safety/protected.js";

// A made-up project folder that does not exist, so its real place is itself.
const root = path.resolve("/tachi-protected-test/project");
const at = (...parts: string[]) => path.join(root, ...parts);
const windows = process.platform === "win32";

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

  it("ignores case on Windows only", () => {
    const cases: [string, string][] = [
      [at(".HUSKY", "pre-commit"), ".HUSKY"],
      [at("web", ".Config", "GIT", "config"), path.join(".Config", "GIT")],
      [at("TOOLS", ".NPMRC"), ".NPMRC"],
      [at("LEFTHOOK-LOCAL.YML"), "LEFTHOOK-LOCAL.YML"],
    ];
    for (const [real, part] of cases) expect(protectedPart(root, real, [], [])).toBe(windows ? part : undefined);
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
