import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { commandEnv, system32 } from "../exec/env.js";

// Files only the user can read: the saved login and its lock (release 2 design, "Private from the
// start"). On macOS and Linux that is mode 700 for the folder and 600 for files. On Windows the
// profile folder also lets in Administrators and the system account, so the folder gets a permission
// that lets in only the user, which files made in it inherit (icacls docs: "(OI) Object inherit",
// "(CI) Container inherit"). Permissions are read back by SID, so the check does not depend on the
// language Windows is set to.

export class PrivateFileError extends Error {}

const windows = process.platform === "win32";
let userSid: string | undefined;

function sid(): string {
  // `whoami /user /fo csv /nh` prints "domain\user","S-1-5-...".
  userSid ??= execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, stdio: "pipe", env: commandEnv() }).trim().split(",")[1]!.replaceAll('"', "");
  return userSid;
}

// The owner and every entry in the permissions of each path: its SID, whether it allows, and its
// inheritance flags. The entries are read as SIDs: turning names back into SIDs fails for some
// accounts, such as ALL APPLICATION PACKAGES, and would leave them out. Any error stops the script.
// The paths go in through the environment, so no quoting is needed.
const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$sid = [System.Security.Principal.SecurityIdentifier]",
  "$out = foreach ($p in ($env:TACHI_ACL_PATHS -split [char]10)) {",
  "  $a = Get-Acl -LiteralPath $p",
  "  [pscustomobject]@{ owner = $a.GetOwner($sid).Value;",
  "    access = @($a.GetAccessRules($true, $true, $sid) | ForEach-Object {",
  "      [pscustomobject]@{ sid = $_.IdentityReference.Value; allow = $_.AccessControlType -eq 'Allow'; inherit = [int]$_.InheritanceFlags } }) }",
  "}",
  "ConvertTo-Json -Compress -Depth 3 -InputObject @($out)",
].join("\n");

type Acl = { owner: string; access: { sid: string; allow: boolean; inherit: number }[] };

function windowsAcl(paths: string[]): Acl[] {
  const out = execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    stdio: "pipe", // errors come back in the thrown error, not printed over the screen
    env: { ...commandEnv(), TACHI_ACL_PATHS: paths.join("\n") },
  });
  return JSON.parse(out);
}

// Every entry lets in the user, and no one else. A folder's must also pass to what is made in it:
// inheritance flags 3 are ContainerInherit and ObjectInherit (.NET's InheritanceFlags).
const onlyUser = (a: Acl, folder = false) =>
  a.access.length > 0 && a.access.every((e) => e.allow && e.sid === sid()) && (!folder || a.access.some((e) => e.inherit === 3));

function icacls(...args: string[]): void {
  execFileSync(system32("icacls.exe"), args, { windowsHide: true, stdio: "ignore", env: commandEnv() });
}

// Paths already checked by this process; each Windows check starts PowerShell, which takes a moment.
const checked = new Set<string>();

// Creates the folder if needed and makes it private.
export function privateDir(dir: string): void {
  if (checked.has(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PrivateFileError(`${dir} is not a plain folder, so the login cannot be kept there safely`);
  if (windows) {
    if (!onlyUser(windowsAcl([dir])[0]!, true)) {
      // Removes inherited entries and leaves the user alone; files already inside inherit that. Other
      // accounts' own entries, which that keeps, are removed next.
      icacls(dir, "/inheritance:r", "/grant:r", `*${sid()}:(OI)(CI)F`);
      const others = [...new Set(windowsAcl([dir])[0]!.access.filter((e) => e.sid !== sid()).map((e) => `*${e.sid}`))];
      try {
        if (others.length) icacls(dir, "/remove", ...others);
      } catch {
        // icacls cannot remove an entry for an account Windows cannot look up; the check below says so
      }
      if (!onlyUser(windowsAcl([dir])[0]!, true)) throw new PrivateFileError(`Could not make ${dir} private to you`);
    }
  } else {
    if (st.uid !== process.getuid!()) throw new PrivateFileError(`${dir} belongs to another user`);
    if (st.mode & 0o077) chmodSync(dir, 0o700);
  }
  checked.add(dir);
}

// Reads a private file, or returns null if there is none. A link or another user's file is refused; a
// file others can read is made private first, and `warn` says so. If that fails, nothing is read.
export function readPrivate(file: string, warn: (message: string) => void): string | null {
  privateDir(path.dirname(file));
  const st = lstatSync(file, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw new PrivateFileError(`${file} is not a plain file, so it was not used`);
  if (st.nlink > 1) throw new PrivateFileError(`${file} has other names (hard links), so it was not used`);
  if (windows) {
    if (!checked.has(file)) {
      const acl = windowsAcl([file])[0]!;
      if (acl.owner !== sid()) throw new PrivateFileError(`${file} belongs to another account, so it was not used`);
      if (!onlyUser(acl)) {
        icacls(file, "/reset"); // back to what it inherits from the private folder
        if (!onlyUser(windowsAcl([file])[0]!)) throw new PrivateFileError(`${file} could be read by others and could not be made private, so it was not used`);
        warn(`${file} could be read by others; it is now private to you.`);
      }
      checked.add(file);
    }
  } else {
    if (st.uid !== process.getuid!()) throw new PrivateFileError(`${file} belongs to another user, so it was not used`);
    if (st.mode & 0o077) {
      chmodSync(file, 0o600);
      if (lstatSync(file).mode & 0o077) throw new PrivateFileError(`${file} could be read by others and could not be made private, so it was not used`);
      warn(`${file} could be read by others; it is now private to you.`);
    }
  }
  return readFileSync(file, "utf8");
}

// On Windows a file another process has open, such as another Tachikoma reading the login, cannot be
// replaced (EPERM). The swap is tried again every millisecond for up to RENAME_RETRY_MS. Measured on
// 2026-10-23, with two processes reading the file nonstop: of 3,000 saves, 27% were refused at first,
// and the slowest went through after 0.76 s. The user chose 1 s.
const RENAME_RETRY_MS = 1_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

function swapIn(temp: string, file: string): void {
  const start = Date.now();
  for (;;) {
    try {
      return renameSync(temp, file);
    } catch (err) {
      const refused = windows && ["EPERM", "EACCES", "EBUSY"].includes((err as NodeJS.ErrnoException).code ?? "");
      if (!refused || Date.now() - start >= RENAME_RETRY_MS) throw err;
      Atomics.wait(pause, 0, 0, 1);
    }
  }
}

// Writes the whole file to a new private file in the same folder, then swaps it in, so it is never
// left half-written.
export function writePrivate(file: string, text: string): void {
  privateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    swapIn(temp, file);
  } catch (err) {
    rmSync(temp, { force: true }); // no copy of the login is left behind
    throw err;
  }
  // Made in the private folder, so it has the folder's permission; nothing more to check.
  checked.add(file);
}
