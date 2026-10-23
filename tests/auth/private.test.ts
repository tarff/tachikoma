import { execFileSync, spawn } from "node:child_process";
import { chmodSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PrivateFileError, privateDir, readPrivate, writePrivate } from "../../src/auth/private.js";
import { system32 } from "../../src/exec/env.js";

// A write that fails part way (a full disk) is made to fail by flushing.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

const windows = process.platform === "win32";
const temp = () => path.join(mkdtempSync(path.join(tmpdir(), "tachi-private-")), "data");

// Every SID in a path's permissions, read as SIDs, so none is left out.
function sids(p: string): string[] {
  const script = "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:P).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...process.env, P: p } })
    .trim()
    .split(/\r?\n/);
}
const icacls = (...args: string[]) => execFileSync(system32("icacls.exe"), args, { stdio: "ignore" });
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

  it("leaves the old file, and no copy, when a write fails", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => writePrivate(file, "two")).toThrow("disk full");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
    expect(readPrivate(file, () => {})).toBe("one");
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

  it("refuses a link in place of the folder, and a folder in place of the file", () => {
    const dir = temp();
    privateDir(dir);
    // A junction on Windows needs no special rights; elsewhere it is an ordinary symlink.
    symlinkSync(dir, `${dir}-link`, "junction");
    expect(() => privateDir(`${dir}-link`)).toThrow("is not a plain folder");
    mkdirSync(path.join(dir, "chatgpt.json"));
    expect(() => readPrivate(path.join(dir, "chatgpt.json"), () => {})).toThrow("is not a plain file");
  });

  // Another Tachikoma reading the login has it open for a moment, and Windows will not replace a file
  // that is open. The save waits for it, for up to 1 s. Resolves once the file is open.
  async function holdOpen(file: string, ms: number): Promise<void> {
    const script = `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:P, 'Open', 'Read', 'ReadWrite'); 'open'; Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const holder = spawn(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, P: file } });
    let out = "";
    holder.stdout.on("data", (d) => (out += d));
    while (!out.includes("open")) await new Promise((r) => setTimeout(r, 20));
  }

  it.runIf(windows)("on Windows, saves while another program has the file open for a moment", async () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    await holdOpen(file, 300); // well under the 1 s the save waits
    writePrivate(file, "two");
    expect(readPrivate(file, () => {})).toBe("two");
  });

  // 15 s, as for the other tests that start a program: PowerShell's start and the 1 s wait.
  it.runIf(windows)("on Windows, gives up after 1 s, keeping the old file and no copy", async () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    writePrivate(file, "one");
    await holdOpen(file, 2_000); // twice the 1 s the save waits
    expect(() => writePrivate(file, "two")).toThrow(`${file} could not be replaced, perhaps because another program has it open, so it was not saved`);
    expect(readPrivate(file, () => {})).toBe("one");
    expect(readdirSync(dir)).toEqual(["chatgpt.json"]);
  }, 15_000);

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

  // ALL APPLICATION PACKAGES (S-1-15-2-1) is one whose name PowerShell cannot turn back into a SID.
  it.runIf(windows)("on Windows, sees every grant, even one whose name cannot be looked up", () => {
    const dir = temp();
    const file = path.join(dir, "chatgpt.json");
    privateDir(dir);
    writeFileSync(file, "x");
    icacls(file, "/grant", "*S-1-15-2-1:R");
    const warnings: string[] = [];
    expect(readPrivate(file, (w) => warnings.push(w))).toBe("x");
    expect(warnings).toHaveLength(1);
    expect(sids(file)).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a folder private that lets another account in", () => {
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/grant", "*S-1-15-2-1:(OI)(CI)R");
    writePrivate(path.join(dir, "chatgpt.json"), "x");
    expect(sids(dir)).toEqual([me()]);
    expect(sids(path.join(dir, "chatgpt.json"))).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, makes a folder private whose files would not inherit its permission", () => {
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/inheritance:r", "/grant:r", `*${me()}:F`); // the user alone, but not passed on to files
    writePrivate(path.join(dir, "chatgpt.json"), "x");
    expect(sids(path.join(dir, "chatgpt.json"))).toEqual([me()]);
  });

  it.runIf(windows)("on Windows, refuses a folder that lets in an account that no longer exists", () => {
    const dir = temp();
    mkdirSync(dir);
    // icacls cannot name such an account, so the entry is added through .NET.
    const script = "$a = Get-Acl -LiteralPath $env:P; $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-1000'), 'Read', 'Allow')); Set-Acl -LiteralPath $env:P -AclObject $a";
    execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, P: dir } });
    expect(() => privateDir(dir)).toThrow(new PrivateFileError(`Could not make ${dir} private to you`));
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
