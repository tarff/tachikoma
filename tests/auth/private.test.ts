import { execFileSync, spawn } from "node:child_process";
import { chmodSync, fsyncSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ownerRefusal, PrivateFileError, privateDir, readPrivate, writePrivate } from "../../src/auth/private.js";
import { commandEnv, system32 } from "../../src/exec/env.js";
import { tempDir } from "../helpers.js";

// A write that fails part way (a full disk) is made to fail by flushing.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync) };
});

// The owner and entries tachi's permissions script reports, and an icacls /reset or /remove that fails, when a test sets
// them: giving a file another owner, or taking the right to change its permissions, takes rights a test does not take, so
// the report is changed instead.
const reported = vi.hoisted(() => ({ owner: undefined as string | undefined, access: undefined as object[] | undefined, resetFails: false, removeFails: false }));
// Every program started through execFileSync, in order, the tests' own included, each kept before it runs, so a call the
// stand-in fails counts too. Kept outside the mocked module, so a fresh copy of private.ts (a new start) records here
// too. For tachi's permissions script: the paths it read, what it gave back, and the paths the stand-in rewrote.
type Call = { program: string; args: string[]; paths?: string[]; out?: string; rewrote?: string[]; failed?: string };
const record = vi.hoisted(() => [] as Call[]);
vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  const execFileSync = (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    const call: Call = { program: file.split(/[\\/]/).at(-1)!.toLowerCase(), args: [...args] };
    record.push(call);
    // Picked out by the variable only tachi's script reads, so the tests' own readers are never rewritten.
    const ours = args.at(-1)?.includes("TACHI_ACL_PATHS") ?? false;
    if (ours) call.paths = String(options.env?.TACHI_ACL_PATHS).split("\n");
    if ((reported.resetFails && args.includes("/reset")) || (reported.removeFails && args.includes("/remove"))) {
      call.failed = "by the stand-in";
      throw new Error(`Command failed: ${file} ${args.join(" ")}`);
    }
    let out;
    try {
      out = cp.execFileSync(file, args, options as never);
    } catch (err) {
      call.failed = (err as Error).message;
      throw err;
    }
    if (!ours) return out;
    if (reported.owner || reported.access) {
      const changed = { ...(reported.owner && { owner: reported.owner }), ...(reported.access && { access: reported.access }) };
      out = JSON.stringify(JSON.parse(String(out)).map((acl: object) => ({ ...acl, ...changed })));
      call.rewrote = call.paths;
    }
    call.out = String(out);
    return out;
  };
  return { ...cp, execFileSync: vi.fn(execFileSync) };
});

const windows = process.platform === "win32";
const temp = () => path.join(tempDir("tachi-private-"), "data");

// Every SID in a path's permissions, read as SIDs, so none is left out. Windows PowerShell starts here, as below, with
// the environment tachi gives it (commandEnv), so under PowerShell 7 it loads its own modules (the CI trial).
function sids(p: string): string[] {
  const script = "$ErrorActionPreference = 'Stop'; (Get-Acl -LiteralPath $env:P).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }";
  return execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...commandEnv(), P: p } })
    .trim()
    .split(/\r?\n/);
}
const icacls = (...args: string[]) => execFileSync(system32("icacls.exe"), args, { stdio: "ignore" });
const me = () => execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" }).trim().split(",")[1]!.replaceAll('"', "");

// The real owner of a path and each of its entries: account, allow or refuse, rights, inheritance and propagation flags,
// and whether it is inherited. Read by a script of the tests' own, which the stand-in never rewrites (above).
type Entry = { sid: string; allow: boolean; rights: number; inherit: number; propagate: number; inherited: boolean };
function look(p: string): { owner: string; access: Entry[] } {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = [System.Security.Principal.SecurityIdentifier]",
    "$a = Get-Acl -LiteralPath $env:P",
    "$access = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value;",
    "  allow = $_.AccessControlType -eq 'Allow'; rights = [int]$_.FileSystemRights; inherit = [int]$_.InheritanceFlags;",
    "  propagate = [int]$_.PropagationFlags; inherited = $_.IsInherited } })",
    "ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ owner = $a.GetOwner($sid).Value; access = $access })",
  ].join("\n");
  return JSON.parse(execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...commandEnv(), P: p } }));
}
// .NET's FileSystemRights.FullControl (0x1F01FF), what icacls's F grants.
const FULL = 2032127;
// What a folder tachi made private holds: one entry, the user's own, allowing full control, passed on to folders and
// files (inheritance flags 3), with no propagation flag.
const privateTo = (user: string) => [{ sid: user, allow: true, rights: FULL, inherit: 3, propagate: 0, inherited: false }];
// ALL APPLICATION PACKAGES, an account every Windows has, which a test can give an entry.
const OTHER = "S-1-15-2-1";

// The calls since the record was emptied, by program; tachi's own permissions reads among them.
const runs = () => ({
  powershell: record.filter((c) => c.program === "powershell.exe").length,
  icacls: record.filter((c) => c.program === "icacls.exe").length,
  whoami: record.filter((c) => c.program === "whoami.exe").length,
});
const reads = () => record.filter((c) => c.paths);
// A new start: a fresh copy of the module, with its own list of checked paths.
async function newStart(): Promise<typeof import("../../src/auth/private.js")> {
  vi.resetModules();
  return import("../../src/auth/private.js");
}
// A folder not yet private, with nothing of another account's own: its only entries are inherited from a parent the
// test made, which lets in the user and ALL APPLICATION PACKAGES.
function inheritsOnly(user: string): string {
  const parent = tempDir("tachi-private-");
  icacls(parent, "/inheritance:r", "/grant:r", `*${user}:(OI)(CI)F`, `*${OTHER}:(OI)(CI)RX`);
  const dir = path.join(parent, "data");
  mkdirSync(dir);
  const before = look(dir).access;
  expect(before.map((e) => e.sid).sort()).toEqual([user, OTHER].sort());
  expect(before.every((e) => e.inherited)).toBe(true);
  return dir;
}
// A folder that lets in another account by an entry of its own, beside the user's.
function withOthersOwn(user: string): string {
  const dir = temp();
  mkdirSync(dir);
  icacls(dir, "/inheritance:r", "/grant:r", `*${user}:(OI)(CI)F`, `*${OTHER}:(OI)(CI)R`);
  expect(look(dir).access.filter((e) => !e.inherited).map((e) => e.sid).sort()).toEqual([user, OTHER].sort());
  return dir;
}
const standInOff = () => expect(reported).toEqual({ owner: undefined, access: undefined, resetFails: false, removeFails: false });

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
    expect(() => privateDir(`${dir}-link`)).toThrow("is not a plain folder, so it cannot be kept private");
    mkdirSync(path.join(dir, "chatgpt.json"));
    expect(() => readPrivate(path.join(dir, "chatgpt.json"), () => {})).toThrow("is not a plain file");
  });

  // Another Tachikoma reading the login has it open for a moment, and Windows will not replace a file
  // that is open. The save waits for it, for up to 1 s. Resolves once the file is open.
  async function holdOpen(file: string, ms: number): Promise<void> {
    const script = `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open($env:P, 'Open', 'Read', 'ReadWrite'); 'open'; Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const holder = spawn(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...commandEnv(), P: file } });
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

  // The CI trial: on Windows Server what an administrator makes is owned by the Administrators group.
  it.runIf(windows)("on Windows, reads a file the Administrators group owns, and refuses one another account owns", () => {
    const dir = temp();
    privateDir(dir);
    const file = path.join(dir, "chatgpt.json");
    const other = path.join(dir, "other.json");
    writeFileSync(file, "x");
    writeFileSync(other, "y");
    try {
      reported.owner = "S-1-5-32-544";
      record.length = 0;
      expect(readPrivate(file, () => {})).toBe("x");
      expect(reads().map((r) => r.rewrote)).toEqual([[file]]); // the stand-in hit the file's one read, and nothing else
      reported.owner = "S-1-5-21-1-2-3-1000";
      record.length = 0;
      expect(() => readPrivate(other, () => {})).toThrow(new PrivateFileError(`${other} belongs to another account, so it was not used`));
      expect(reads().map((r) => r.rewrote)).toEqual([[other]]);
    } finally {
      reported.owner = undefined;
    }
  });

  // A file an administrator owns, which others can read, may not let the user change its permissions (the review of the
  // CI trial's fixes): it is refused in tachi's words, not icacls's.
  it.runIf(windows)("on Windows, refuses a file others can read whose permissions cannot be reset, saying so", () => {
    const dir = temp();
    privateDir(dir);
    const file = path.join(dir, "chatgpt.json");
    writeFileSync(file, "x");
    try {
      Object.assign(reported, { owner: "S-1-5-32-544", access: [{ sid: "S-1-1-0", allow: true, inherit: 0 }], resetFails: true }); // Everyone
      const refused = `${file} could be read by others and could not be made private, so it was not used`;
      record.length = 0;
      expect(() => readPrivate(file, () => {})).toThrow(new PrivateFileError(refused));
      // The file's read, the /reset the stand-in failed, and the read after it, each rewritten for the file alone.
      expect(reads().map((r) => r.rewrote)).toEqual([[file], [file]]);
      expect(record.find((c) => c.args.includes("/reset"))?.failed).toBe("by the stand-in");
    } finally {
      Object.assign(reported, { owner: undefined, access: undefined, resetFails: false });
    }
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
    const powershell = system32("WindowsPowerShell/v1.0/powershell.exe");
    execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...commandEnv(), P: dir } });
    standInOff();
    record.length = 0;
    expect(() => privateDir(dir)).toThrow(new PrivateFileError(`Could not make ${dir} private to you`));
    // What the real /remove did, which nobody had seen: in the test's output. Either way the folder is read after it,
    // and that read still shows the account's entry.
    const at = record.findIndex((c) => c.args.includes("/remove"));
    expect(at).toBeGreaterThan(-1);
    console.log(`icacls /remove of an account that no longer exists: ${record[at]!.failed === undefined ? "returned" : `failed (${record[at]!.failed})`}`);
    const after = record.slice(at + 1).filter((c) => c.paths);
    expect(after).toHaveLength(1);
    expect(JSON.parse(after[0]!.out!)[0].access.map((e: { sid: string }) => e.sid)).toContain("S-1-5-21-1-2-3-1000");
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

// The programs one folder check starts on Windows (cleanup plan, step 14c, part 1), counted from the record: each
// count is of calls made, the record emptied just before the call under test. Before: 3 PowerShell runs, 1 icacls and 1
// whoami for a folder not yet private; 1 PowerShell run and 1 whoami for one already private.
describe.runIf(windows)("on Windows, the programs a folder's privacy check starts", () => {
  it("the tests' own reader is never rewritten by the stand-in", () => {
    const dir = temp();
    mkdirSync(dir);
    const real = look(dir);
    try {
      Object.assign(reported, { owner: "S-1-5-21-1-2-3-1000", access: [{ sid: OTHER, allow: true, inherit: 0 }] });
      record.length = 0;
      expect(look(dir)).toEqual(real);
      expect(record).toHaveLength(1);
      expect(record[0]!.rewrote).toBeUndefined();
    } finally {
      Object.assign(reported, { owner: undefined, access: undefined });
    }
  });

  it("a new start's calls land in the record the tests read", async () => {
    const { privateDir: check } = await newStart();
    const dir = temp();
    record.length = 0;
    check(dir);
    expect(reads().map((r) => r.paths)).toContainEqual([dir]);
  });

  it("the account in tachi's own permissions read is the one whoami gives", async () => {
    standInOff();
    const { privateDir: check } = await newStart();
    const dir = temp();
    record.length = 0;
    check(dir);
    const read = reads()[0]!;
    expect(read.rewrote).toBeUndefined();
    const account = JSON.parse(read.out!)[0].user;
    const whoami = me();
    console.log(`ran on: ${process.env.GITHUB_ACTIONS === "true" ? "GitHub's Windows machine (CI)" : "a machine that is not CI"}; PowerShell's account ${account}, whoami's ${whoami}`);
    expect(account).toBe(whoami);
  });

  it("not private, with nothing of another account's own, on a new start: 2 PowerShell runs and 1 icacls", async () => {
    const user = me();
    const dir = inheritsOnly(user);
    const { privateDir: check } = await newStart();
    record.length = 0;
    check(dir);
    expect(runs()).toEqual({ powershell: 2, icacls: 1, whoami: 0 });
    expect(look(dir).access).toEqual(privateTo(user));
  });

  it("already private, on a new start: 1 PowerShell run and nothing else", async () => {
    const user = me();
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/inheritance:r", "/grant:r", `*${user}:(OI)(CI)F`);
    expect(look(dir).access).toEqual(privateTo(user));
    const { privateDir: check } = await newStart();
    record.length = 0;
    check(dir);
    expect(runs()).toEqual({ powershell: 1, icacls: 0, whoami: 0 });
  });

  it("checked, then given another account's own entry, then met by a new start: 3 PowerShell runs and 2 icacls", async () => {
    const user = me();
    const dir = temp();
    privateDir(dir);
    icacls(dir, "/grant", `*${OTHER}:(OI)(CI)R`);
    expect(look(dir).access.filter((e) => !e.inherited).map((e) => e.sid).sort()).toEqual([user, OTHER].sort());
    const { privateDir: check } = await newStart();
    record.length = 0;
    check(dir);
    expect(runs()).toEqual({ powershell: 3, icacls: 2, whoami: 0 });
    // The folder is read again after the removal.
    const removal = record.findIndex((c) => c.args.includes("/remove"));
    expect(record.slice(removal + 1).filter((c) => c.paths)).toHaveLength(1);
    expect(look(dir).access).toEqual(privateTo(user));
  });

  it("a removal that fails is followed by a read, which still shows the entry, and the folder is refused", async () => {
    const user = me();
    const dir = withOthersOwn(user);
    const { privateDir: check } = await newStart();
    try {
      reported.removeFails = true;
      record.length = 0;
      expect(() => check(dir)).toThrow(`Could not make ${dir} private to you`);
      expect(runs()).toEqual({ powershell: 3, icacls: 2, whoami: 0 }); // the second icacls is the stand-in's failure
      const removal = record.findIndex((c) => c.args.includes("/remove"));
      expect(record[removal]!.failed).toBe("by the stand-in");
      const after = record.slice(removal + 1).filter((c) => c.paths);
      expect(after).toHaveLength(1);
      expect(JSON.parse(after[0]!.out!)[0].access.map((e: { sid: string }) => e.sid)).toContain(OTHER);
    } finally {
      reported.removeFails = false;
    }
  });

  it("nothing to remove, and still not private: refused after 2 PowerShell runs and 1 icacls", async () => {
    const user = me();
    const dir = inheritsOnly(user);
    const { privateDir: check } = await newStart();
    try {
      reported.access = [{ sid: user, allow: false, inherit: 3 }]; // one entry, refusing the user
      record.length = 0;
      expect(() => check(dir)).toThrow(`Could not make ${dir} private to you`);
      expect(runs()).toEqual({ powershell: 2, icacls: 1, whoami: 0 });
      expect(reads().map((r) => r.rewrote)).toEqual([[dir], [dir]]); // both reads, of this folder alone
    } finally {
      reported.access = undefined;
    }
  });

  it("a second call on the same folder in the same start makes no call at all", async () => {
    const { privateDir: check } = await newStart();
    const dir = temp();
    record.length = 0;
    check(dir);
    expect(runs().powershell).toBeGreaterThan(0);
    record.length = 0;
    check(dir);
    expect(record).toEqual([]);
  });

  it("a folder replaced by a junction between two starts is refused by the new start", async () => {
    const dir = temp();
    privateDir(dir);
    renameSync(dir, `${dir}-moved`);
    symlinkSync(`${dir}-moved`, dir, "junction");
    const { privateDir: check } = await newStart();
    expect(() => check(dir)).toThrow(`${dir} is not a plain folder, so it cannot be kept private`);
  });
});

// A folder's owner on Windows (cleanup plan, step 14c, part 2): the user's own account and the Administrators group are
// accepted, as for a file; any other owner is refused at the first read, before any permission is changed. A test can
// give a folder no other owner without rights it does not take, so the stand-in reports one.
describe.runIf(windows)("on Windows, a folder's owner", () => {
  // The approved words (decision 1, 2026-11-27).
  const refusal = (dir: string) =>
    `${dir} belongs to another account, so it cannot be kept private; Tachikoma stopped before changing its permissions. ` +
    `To use it, either make your own account its owner, in PowerShell run as administrator while signed in as your own account: takeown /f '${dir.replaceAll("'", "''")}' /r /d Y; ` +
    `or rename it (for example to ${path.basename(dir)}.old), which sets aside what it holds and lets Tachikoma make a new, empty one. Then start Tachikoma again.`;
  const ANOTHER = "S-1-5-21-1-2-3-1000"; // an account of no one here
  // Refused with that error, of the module copy that threw it.
  function refused(m: typeof import("../../src/auth/private.js"), act: () => unknown, dir: string): void {
    let err: unknown;
    try {
      act();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(m.PrivateFileError);
    expect((err as Error).message).toBe(refusal(dir));
  }
  // A folder already private to the user, by the test's own icacls, confirmed by the reader.
  function alreadyPrivate(user: string): string {
    const dir = temp();
    mkdirSync(dir);
    icacls(dir, "/inheritance:r", "/grant:r", `*${user}:(OI)(CI)F`);
    expect(look(dir).access).toEqual(privateTo(user));
    return dir;
  }
  const reportOwner = (owner: string | undefined) => Object.assign(reported, { owner });

  // Text only: no folder is made and nothing is run with this path (Codex review).
  it("gives the takeown line the path as a PowerShell single-quoted literal, so a $, a backtick or an apostrophe stays itself", () => {
    const dir = "C:\\Users\\a$name`b'c\\data";
    expect(ownerRefusal(dir)).toContain(" own account: takeown /f 'C:\\Users\\a$name`b''c\\data' /r /d Y; or rename it ");
  });

  it("refuses a folder really private to the user whose reported owner is another account, after 1 PowerShell run", async () => {
    const dir = alreadyPrivate(me());
    const m = await newStart();
    try {
      reportOwner(ANOTHER);
      record.length = 0;
      refused(m, () => m.privateDir(dir), dir);
      expect(runs()).toEqual({ powershell: 1, icacls: 0, whoami: 0 });
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]);
    } finally {
      reportOwner(undefined);
    }
  });

  it("refuses a folder not private whose reported owner is another account, leaving its permissions as they were", async () => {
    const dir = inheritsOnly(me());
    const before = look(dir);
    const m = await newStart();
    try {
      reportOwner(ANOTHER);
      record.length = 0;
      refused(m, () => m.privateDir(dir), dir);
      expect(runs()).toEqual({ powershell: 1, icacls: 0, whoami: 0 });
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]);
    } finally {
      reportOwner(undefined);
    }
    expect(look(dir)).toEqual(before);
  });

  it("refuses a folder whose reported owner is the system account", async () => {
    const dir = alreadyPrivate(me());
    const m = await newStart();
    try {
      reportOwner("S-1-5-18");
      record.length = 0;
      refused(m, () => m.privateDir(dir), dir);
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]);
    } finally {
      reportOwner(undefined);
    }
  });

  it("accepts a folder whose reported owner is the Administrators group, private or made private", async () => {
    const user = me();
    const ready = alreadyPrivate(user);
    const open = inheritsOnly(user);
    const m = await newStart();
    try {
      reportOwner("S-1-5-32-544");
      record.length = 0;
      m.privateDir(ready);
      expect(runs()).toEqual({ powershell: 1, icacls: 0, whoami: 0 });
      expect(reads().map((r) => r.rewrote)).toEqual([[ready]]);
      record.length = 0;
      m.privateDir(open);
      expect(runs()).toEqual({ powershell: 2, icacls: 1, whoami: 0 });
      expect(reads().map((r) => r.rewrote)).toEqual([[open], [open]]);
    } finally {
      reportOwner(undefined);
    }
    expect(look(open).access).toEqual(privateTo(user));
  });

  it("takes a folder the test made, with its real owner, through the check private and needing repair", async () => {
    standInOff();
    const user = me();
    const ready = alreadyPrivate(user);
    const open = inheritsOnly(user);
    const owners = [look(ready).owner, look(open).owner];
    const kind = (o: string) => (o === user ? "the user's own account" : o === "S-1-5-32-544" ? "the Administrators group (S-1-5-32-544)" : "another account");
    console.log(`the real owner of the test's folders: ${owners.map(kind).join(", ")}`);
    for (const o of owners) expect([user, "S-1-5-32-544"]).toContain(o);
    const m = await newStart();
    record.length = 0;
    m.privateDir(ready);
    m.privateDir(open);
    expect(reads().every((r) => r.rewrote === undefined)).toBe(true);
    expect(look(ready).access).toEqual(privateTo(user));
    expect(look(open).access).toEqual(privateTo(user));
  });

  it("asks Windows again about a refused folder, and uses it once its owner is right", async () => {
    const dir = alreadyPrivate(me());
    const m = await newStart();
    try {
      reportOwner(ANOTHER);
      refused(m, () => m.privateDir(dir), dir);
      record.length = 0;
      refused(m, () => m.privateDir(dir), dir);
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]);
    } finally {
      reportOwner(undefined);
    }
    record.length = 0;
    m.privateDir(dir);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]!.rewrote).toBeUndefined();
  });

  it("refuses readPrivate in a folder another account owns, giving nothing back and leaving the file as it was", async () => {
    const dir = temp();
    mkdirSync(dir);
    const file = path.join(dir, "chatgpt.json");
    writeFileSync(file, "kept");
    const before = look(file);
    const m = await newStart();
    try {
      reportOwner(ANOTHER);
      record.length = 0;
      let got: string | null | undefined;
      refused(m, () => (got = m.readPrivate(file, () => {})), dir);
      expect(got).toBeUndefined();
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]); // the folder's read only: the file was never read
    } finally {
      reportOwner(undefined);
    }
    expect(readFileSync(file, "utf8")).toBe("kept");
    expect(look(file)).toEqual(before);
  });

  it("refuses writePrivate in a folder another account owns, leaving the folder empty", async () => {
    const dir = temp();
    mkdirSync(dir);
    const m = await newStart();
    try {
      reportOwner(ANOTHER);
      record.length = 0;
      refused(m, () => m.writePrivate(path.join(dir, "chatgpt.json"), "x"), dir);
      expect(reads().map((r) => r.rewrote)).toEqual([[dir]]);
    } finally {
      reportOwner(undefined);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
