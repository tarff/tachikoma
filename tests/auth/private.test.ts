import { execFileSync } from "node:child_process";
import { chmodSync, linkSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PrivateFileError, privateDir, readPrivate, writePrivate } from "../../src/auth/private.js";
import { system32 } from "../../src/exec/env.js";

const windows = process.platform === "win32";
const temp = () => path.join(mkdtempSync(path.join(tmpdir(), "tachi-private-")), "data");

// Every SID in a path's permissions, read the way the code reads them.
function sids(p: string): string[] {
  const script = "(Get-Acl -LiteralPath $env:P).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, P: p } })
    .trim()
    .split(/\r?\n/);
}
const me = () => execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",")[1]!.replaceAll('"', "");

describe("private files", () => {
  it("writes the whole file, leaving no temporary copy, and reads it back", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    writePrivate(file, "two");
    expect(readPrivate(file, () => {})).toBe("two");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
  });

  it("reads a missing file as null", () => {
    expect(readPrivate(path.join(temp(), "none.json"), () => {})).toBeNull();
  });

  it("refuses a file with another name (a hard link)", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    linkSync(file, path.join(dir, "copy"));
    expect(() => readPrivate(file, () => {})).toThrow(PrivateFileError);
  });

  it("refuses a link in place of the file", (ctx) => {
    const dir = temp();
    privateDir(dir);
    writeFileSync(path.join(dir, "real"), "{}");
    try {
      symlinkSync(path.join(dir, "real"), path.join(dir, "chatgpt.json"), "file");
    } catch {
      return ctx.skip(); // Windows allows file symlinks only with Developer Mode or as an administrator
    }
    expect(() => readPrivate(path.join(dir, "chatgpt.json"), () => {})).toThrow("is not a plain file");
  });

  it.runIf(windows)("on Windows, lets in only the user, from the start", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    expect(sids(dir)).toEqual([me()]);
    expect(sids(file)).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a file others can read private, and says so", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    privateDir(dir);
    writeFileSync(file, "x");
    execFileSync(system32("icacls.exe"), [file, "/grant", "*S-1-1-0:R"], { stdio: "ignore" }); // Everyone
    const warnings: string[] = [];
    expect(readPrivate(file, (w) => warnings.push(w))).toBe("x");
    expect(warnings).toEqual([`${file} could be read by others; it is now private to you.`]);
    expect(sids(file)).toEqual([me()]);
  });

  it.skipIf(windows)("elsewhere, uses mode 700 and 600, and fixes a file others can read", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "x");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    const warnings: string[] = [];
    readPrivate(file, (w) => warnings.push(w));
    expect(warnings).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
