import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
  userSid ??= execFileSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, env: commandEnv() }).trim().split(",")[1]!.replaceAll('"', "");
  return userSid;
}

// The owner and every SID named in the permissions of each path. The paths go in through the
// environment, so no quoting is needed.
const ACL_SCRIPT = [
  "$out = foreach ($p in ($env:TACHI_ACL_PATHS -split [char]10)) {",
  "  $a = Get-Acl -LiteralPath $p",
  "  [pscustomobject]@{ owner = $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;",
  "    access = @($a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }) }",
  "}",
  "ConvertTo-Json -Compress -InputObject @($out)",
].join("\n");

function windowsAcl(paths: string[]): { owner: string; access: string[] }[] {
  const out = execFileSync(system32("WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...commandEnv(), TACHI_ACL_PATHS: paths.join("\n") },
  });
  return JSON.parse(out);
}

const onlyUser = (a: { access: string[] }) => a.access.length > 0 && a.access.every((s) => s === sid());

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
    if (!onlyUser(windowsAcl([dir])[0]!)) {
      // Removes inherited entries and leaves the user alone; files already inside inherit that.
      icacls(dir, "/inheritance:r", "/grant:r", `*${sid()}:(OI)(CI)F`);
      if (!onlyUser(windowsAcl([dir])[0]!)) throw new PrivateFileError(`Could not make ${dir} private to you`);
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

// Writes the whole file to a new private file in the same folder, then swaps it in, so it is never
// left half-written.
export function writePrivate(file: string, text: string): void {
  privateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (err) {
    unlinkSync(temp);
    throw err;
  }
  // Made in the private folder, so it has the folder's permission; nothing more to check.
  checked.add(file);
}
