import { describe, expect, it } from "vitest";
import { type Context, type Danger, dangers, KINDS, shown, type UserRules } from "../../src/safety/rules.js";
import type { Shell } from "../../src/safety/split.js";

// No file is looked for on this machine: npx's programs are found only where a test says (choice 47).
const BASH: Context = { root: "/tmp/x", home: "/home/u", shell: "bash", has: () => false };
const PS: Context = { root: "C:\\work\\x", home: "C:\\Users\\u", shell: "powershell", has: () => false };
const BOX: Context = { root: "/work", home: "/home/u", shell: "bash", has: () => false };
const GIT_BASH: Context = { root: "C:\\work\\x", home: "C:\\Users\\u", shell: "bash", has: () => false };

const WIPE = "wiping or formatting disks";
const DELETE = "deleting whole folders";
const PERMS = "permissions and system settings";
const STOP = "stopping processes or the machine";
const GIT = "rewriting or deleting git history";
const SEND = "sending files out";
const INSTALL = "installing software";
const RUN = "downloading and running code";
const OUTSIDE = "acting outside the machine";

// Each line: the shell, the command line, and the kinds of the dangers found, in order; [] for a line that passes.
const TABLE: [Shell, string, Danger["kind"][]][] = [
  // Wiping or formatting disks
  ["powershell", "format D: /q", [WIPE]],
  ["powershell", "FORMAT D:", [WIPE]],
  ["powershell", "C:\\Windows\\System32\\format.com D:", [WIPE]],
  ["powershell", "diskpart", [WIPE]],
  ["powershell", "Clear-Disk -Number 1", [WIPE]],
  ["powershell", "clear-disk 1", [WIPE]],
  ["powershell", "Format-Volume -DriveLetter D", [WIPE]],
  ["powershell", "Initialize-Disk 1", [WIPE]],
  ["bash", "mkfs /dev/sdb1", [WIPE]],
  ["bash", "mkfs.ext4 /dev/sdb1", [WIPE]],
  ["bash", "wipefs -a /dev/sdb", [WIPE]],
  ["bash", "fdisk /dev/sdb", [WIPE]],
  ["bash", "parted /dev/sdb mklabel gpt", [WIPE]],
  ["bash", "dd if=/dev/zero of=/dev/sdb bs=1M", [WIPE]],
  ["powershell", "cipher /w:C:\\work\\x", [WIPE]],
  ["powershell", "cipher /W:C:\\", [WIPE]],
  ["powershell", "wsl --unregister Ubuntu", [WIPE]],
  ["powershell", "wsl.exe --unregister Ubuntu", [WIPE]],
  ["bash", "echo format", []],
  ["powershell", "echo format", []],
  ["powershell", "Get-Process | Format-Table", []],
  ["bash", "dd if=/dev/sdb of=/tmp/x/disk.img", []],
  ["powershell", "cipher /e x", []],
  ["powershell", "wsl --list", []],
  // Choice 51: look-only forms pass
  ["bash", "dd if=/dev/zero of=/dev/null bs=1M count=1", []],
  ["bash", "dd if=x of=/dev/stdout", []],
  ["bash", "dd if=x of=/dev/stderr", []],
  ["bash", "fdisk -l", []],
  ["bash", "fdisk -l /dev/sda", []],
  ["bash", "fdisk --list", []],
  ["bash", "fdisk -lu", []],
  ["bash", "parted -l", []],
  ["bash", "parted --list -m", []],
  ["bash", "dd if=/dev/zero of=/dev/nullx", [WIPE]],
  ["bash", "fdisk -b 2048 /dev/sdb", [WIPE]],
  ["bash", "parted -l /dev/sdb mklabel gpt", [WIPE]],

  // Deleting whole folders
  ["bash", "rm -rf /", [DELETE]],
  ["bash", "rm -fr ~", [DELETE]],
  ["bash", "rm -Rf $HOME", [DELETE]],
  ["bash", 'rm -rf "${HOME}/"', [DELETE]],
  ["bash", "rm -r -f /home/u/", [DELETE]],
  ["bash", "rm -r /home/u", [DELETE]],
  ["bash", "rm --recursive --force /tmp/x", [DELETE]],
  ["bash", "rm -rf .", [DELETE]],
  ["bash", "rm -rf ./", [DELETE]],
  ["bash", "rm -rf *", [DELETE]],
  ["bash", "rm -rf ..", [DELETE]],
  ["bash", "rm -rf ../..", [DELETE]],
  ["bash", "rm -rf ~/*", [DELETE]],
  ["bash", "rm -rf -- /", [DELETE]],
  ["bash", "/usr/bin/rm -rf /", [DELETE]],
  ["bash", "RM -rf /", [DELETE]],
  ["bash", "FOO=1 rm -rf ~", [DELETE]],
  ["bash", "env -i rm -rf ~", [DELETE]],
  ["bash", "bash -c 'rm -rf ~'", [DELETE]],
  ["bash", "pwsh -c 'remove-item -recurse ~'", [DELETE]],
  ["powershell", "Remove-Item -Recurse -Force C:\\", [DELETE]],
  ["powershell", "remove-item -recurse ~", [DELETE]],
  ["powershell", "Remove-Item -Rec -Path C:\\work\\x", [DELETE]],
  ["powershell", "Remove-Item -Recurse c:\\WORK\\X\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse .", [DELETE]],
  ["powershell", "Remove-Item -Recurse C:/", [DELETE]],
  ["powershell", "rm -r $env:USERPROFILE", [DELETE]],
  ["powershell", "rm -r $HOME", [DELETE]],
  ["powershell", "ri -Recurse C:\\Users\\u", [DELETE]],
  ["powershell", "del -Recurse c:/users/u/", [DELETE]],
  ["powershell", "rd /s /q C:\\work\\x", [DELETE]],
  ["powershell", "rmdir /S C:\\", [DELETE]],
  ["powershell", "cmd /c rd /s/q C:\\", [DELETE]],
  ["powershell", "wsl rm -rf /", [DELETE]],
  // Paths are worked out: the home forms, $PWD, relative paths from the project, . and .., and a folder above home or root
  ["bash", "rm -rf ~/", [DELETE]],
  ["bash", "rm -rf $HOME/.", [DELETE]],
  ["bash", 'rm -rf "$PWD"', [DELETE]],
  ["bash", "rm -rf ${PWD}/", [DELETE]],
  ["bash", "rm -rf /home", [DELETE]],
  ["bash", "rm -rf /tmp", [DELETE]],
  ["bash", "rm -rf ../x", [DELETE]],
  ["bash", "rm -rf /tmp/x/./", [DELETE]],
  ["bash", "rm -rf //tmp//x", [DELETE]],
  ["powershell", "Remove-Item -Recurse $env:USERPROFILE\\..", [DELETE]],
  ["powershell", "Remove-Item -Recurse $Env:UserProfile\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse $PWD", [DELETE]],
  ["powershell", "Remove-Item -Recurse ..\\x", [DELETE]],
  ["powershell", "Remove-Item -Recurse C:\\Users", [DELETE]],
  ["bash", "rm -rf src/../build", []],
  ["bash", "rm -rf ../y", []],
  ["bash", "rm -rf $HOME/x", []],
  ["powershell", "Remove-Item -Recurse $env:USERPROFILE\\x", []],
  // Choice 52: each call starts a new shell in the project's root, and a literal cd is followed from the folder before it.
  // Every folder met counts for every command, as a cd in a subshell or loop, or one that fails, leaves the line elsewhere.
  ["bash", "cd sub && rm -rf ..", [DELETE]],
  ["bash", 'cd /tmp && rm -rf "$PWD"', [DELETE]],
  ["bash", "cd .. && rm -rf x", [DELETE]],
  ["bash", "cd / && rm -rf home", [DELETE]],
  ["bash", "cd /tmp && rm -rf x", [DELETE]],
  ["bash", "cd /tmp/y && rm -rf ../x", [DELETE]],
  ["bash", "cd -- / && rm -rf home", [DELETE]],
  ["bash", "cd -P / && rm -rf home", [DELETE]],
  ["bash", "cd && rm -rf ..", [DELETE]], // cd alone goes home
  ["bash", "cd a && cd ../.. && rm -rf x", [DELETE]],
  ["bash", "(cd deep/a/b); rm -rf ../..", [DELETE]],
  ["bash", "for d in a b; do rm -rf x; cd ..; done", [DELETE]],
  ["bash", "pushd / && rm -rf home", [DELETE]],
  ["powershell", "Set-Location sub; Remove-Item -Recurse ..", [DELETE]],
  ["powershell", "Set-Location C:\\; Remove-Item -Recurse Users", [DELETE]],
  ["powershell", "cd ..; Remove-Item -Recurse x", [DELETE]],
  ["powershell", "sl -Path \\; ri -Recurse work", [DELETE]],
  ["powershell", "Push-Location -LiteralPath:C:\\work; Remove-Item -Recurse x", [DELETE]],
  ["powershell", "pushd C:\\Users; rm -r u", [DELETE]],
  ["powershell", "Set-Location FileSystem::C:\\; Remove-Item -Recurse Users", [DELETE]],
  ["bash", "cd sub && rm -rf build", []],
  ["bash", "cd sub && rm -rf ../other", []],
  ["bash", "cd /tmp/y && rm -rf build", []],
  ["bash", "cd /tmp/y && cd sub && rm -rf build", []],
  ["bash", "cd sub && cd /tmp && rm -rf build", []],
  ["powershell", "cd sub; Remove-Item -Recurse ..\\other", []],
  // Each cd from the current folder is counted, a repeated one too, and more than one leaves the folder unknown, so a
  // relative delete asks; a cd that may not hold (in a subshell or a child shell, or one that fails) is kept beside the
  // folder before it, so a delete that is whole from either asks
  ["bash", "cd .. && cd .. && rm -rf tmp", [DELETE]],
  ["bash", "cd ..; cd ..; rm -rf tmp", [DELETE]],
  ["powershell", "cd ..; cd ..; Remove-Item -Recurse work", [DELETE]],
  ["bash", "(cd sub); cd ..; rm -rf x", [DELETE]],
  ["bash", "bash -c 'cd sub'; cd ..; rm -rf x", [DELETE]],
  ["bash", "cd nosuch; cd ..; rm -rf x", [DELETE]],
  ["bash", "(cd sub && make) && cd .. && rm -rf x", [DELETE]],
  ["bash", "cd sub && cd .. && rm -rf build", [DELETE]],
  // A cd in a loop or a function may run more than once, so with a loop or function on the line a cd from the current
  // folder leaves it unknown
  ["bash", "for d in a b c; do cd ..; done; rm -rf tmp", [DELETE]],
  ["bash", "up() { cd ..; }; up; up; rm -rf tmp", [DELETE]],
  ["bash", "function up { cd ..; }; up; up; rm -rf tmp", [DELETE]],
  ["bash", "while true; do cd ..; done; rm -rf tmp", [DELETE]],
  ["bash", "until false; do cd ..; done; rm -rf tmp", [DELETE]],
  ["bash", "select d in a; do cd ..; done; rm -rf tmp", [DELETE]],
  ["powershell", "1..3 | ForEach-Object { cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "1..3 | % { cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "foreach ($i in 1..3) { cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "for ($i = 0; $i -lt 3; $i++) { cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "while ($true) { cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "do { cd .. } while ($true); Remove-Item -Recurse work", [DELETE]],
  ["powershell", "function up { cd .. }; up; up; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "filter up { cd .. }; 1, 2 | up; Remove-Item -Recurse work", [DELETE]],
  ["bash", "for f in a b; do echo $f; done; rm -rf build", []],
  ["bash", "for f in a; do cd /tmp/y; done; rm -rf build", []],
  ["powershell", "1..3 | ForEach-Object { $_ }; Remove-Item -Recurse build", []],
  // A PowerShell script block given to pwsh is read once, though the reader reads it as a block and as pwsh's text
  ["powershell", "pwsh -Command { Set-Location sub; Remove-Item -Recurse build }", []],
  ["powershell", "pwsh -Command { Set-Location ..; Remove-Item -Recurse x }", [DELETE]],
  // Text in quotes from bash or cmd is read once, as pwsh's text, so its cds count
  ["bash", "pwsh -c '{ cd ..; cd .. }'; rm -rf tmp", [DELETE]],
  ["bash", "cmd /c 'pwsh -Command \"{ cd ..; cd .. }\" && rd /s /q work'", [DELETE]],
  // PowerShell's where with a block, and .ForEach{ } and .Where{ }, run a block for each item
  ["powershell", "1..3 | where { cd ..; $true }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "(1..3).ForEach{ cd .. }; Remove-Item -Recurse work", [DELETE]],
  ["powershell", "Get-Command where; cd sub; Remove-Item -Recurse ..\\other", []],
  // cmd ends a built-in's name at ; , = and + too
  ["powershell", "cmd /c 'cd;.. && rd /s /q x'", [DELETE]],
  ["powershell", "cmd /c 'cd=.. && rd /s /q x'", [DELETE]],
  ["powershell", "cmd /c 'cd,.. && rd /s /q x'", [DELETE]],
  // A link can make any relative path lead anywhere, so a line that makes one leaves the folder unknown
  ["bash", "ln -s / x && rm -rf x/home", [DELETE]],
  ["bash", "ln --symbolic / x; cd x && rm -rf home", [DELETE]],
  ["bash", "ln a b && rm -rf build", [DELETE]],
  ["powershell", "cmd /c mklink /d x C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -ItemType SymbolicLink -Path x -Target C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "ni x -ItemType:Junction -Value C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -Type HardLink -Path a -Target b; Remove-Item -Recurse build", [DELETE]],
  // New-Item's FileSystem provider takes any start of a type's name, and wildcards
  ["powershell", "New-Item -ItemType sym -Path x -Target C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -ItemType j -Path x -Target C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -ItemType h -Path a -Target b; Remove-Item -Recurse build", [DELETE]],
  ["powershell", "New-Item -ItemType *link -Path x -Target C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -ItemType ?unction -Path x -Target C:\\; Remove-Item -Recurse x\\Users", [DELETE]],
  ["powershell", "New-Item -ItemType $t -Path x; Remove-Item -Recurse build", [DELETE]],
  ["powershell", "New-Item -ItemType Directory build; Remove-Item -Recurse build", []],
  ["powershell", "ni -ItemType d build; Remove-Item -Recurse build", []],
  ["powershell", "New-Item -ItemType:File x; Remove-Item -Recurse build", []],
  ["powershell", "New-Item -Type container x; Remove-Item -Recurse build", []],
  ["powershell", "New-Item x; Remove-Item -Recurse build", []],
  // bash's HOME, PWD or CDPATH named bare anywhere (set, read, declared) leaves the folder unknown; reading $HOME does not
  ["bash", "read HOME; rm -rf build", [DELETE]],
  ["bash", "printf -v HOME x; rm -rf build", [DELETE]],
  ["bash", "declare HOME=/; rm -rf build", [DELETE]],
  ["bash", "export PWD; rm -rf build", [DELETE]],
  ["bash", "unset CDPATH; rm -rf build", [DELETE]],
  // The name split by quotes or a backslash, which the shell joins, and the expansions that set it
  ["bash", 'export HO""ME=/tmp; cd; rm -rf x', [DELETE]],
  ["bash", "export H\\OME=/tmp; cd; rm -rf x", [DELETE]],
  ["bash", "declare H''OME=/tmp; cd; rm -rf x", [DELETE]],
  ["bash", "read H\\OME; cd; rm -rf x", [DELETE]],
  ["bash", "printf -v 'HOME' /tmp; cd; rm -rf x", [DELETE]],
  ["bash", 'declare -n r=H""OME; cd; rm -rf x', [DELETE]],
  ["bash", ': "${HOME:=/}"; cd; rm -rf x', [DELETE]],
  ["bash", ": ${HOME=/}; cd; rm -rf x", [DELETE]],
  ["bash", "HOME=/x cd; rm -rf y", [DELETE]],
  ["bash", 'echo "${HOME:-x}" "${HOME:?}"; cd; rm -rf x', []],
  ["bash", 'echo "$HOME" "${HOME}" "$PWD"; cd; rm -rf x', []],
  ["bash", 'rm -rf "$HOME/x"', []],
  ["bash", 'rm -rf "${HOME}/x"', []],
  ["bash", "cd ~ && rm -rf build", []],
  ["bash", 'cd "$HOME" && rm -rf build', []],
  ["bash", "echo $OLDPWD $PWD; rm -rf build", []],
  // A change of folder the check cannot place leaves it unknown: what climbs out of it, or is it, counts
  ["bash", 'cd "$d" && rm -rf ../other', [DELETE]],
  ["bash", "cd - && rm -rf ../other", [DELETE]],
  ["bash", "cd a b && rm -rf ../other", [DELETE]],
  ["bash", "cd s* && rm -rf ../other", [DELETE]],
  ["bash", "pushd x && popd && rm -rf ../other", [DELETE]],
  ["bash", "builtin cd sub && rm -rf ../other", [DELETE]],
  ["bash", "command cd sub && rm -rf ../other", [DELETE]],
  ["bash", "export CDPATH=/tmp; cd y && rm -rf ../other", [DELETE]],
  ["bash", "find . -execdir rm -rf ../other \\;", [DELETE]],
  ["bash", "find . -okdir rm -rf ../other \\;", [DELETE]],
  ["bash", "env -C sub rm -rf ../other", [DELETE]],
  ["bash", "sudo -D sub rm -rf ../other", [PERMS, DELETE]],
  ["bash", "chroot /mnt rm -rf ../other", [DELETE]],
  ["bash", "unshare --wd /tmp rm -rf ../other", [DELETE]],
  ["bash", "systemd-run rm -rf ../other", [DELETE]],
  ["powershell", "cd\\; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "cd..; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "chdir\\; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "cd D:; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "cd HKLM:\\; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "cd $env:TEMP; Remove-Item -Recurse ..\\other", [DELETE]],
  ["powershell", "cmd /c 'cd /d D:\\y && rd /s /q ..\\other'", [DELETE]],
  ["powershell", "pwsh -WorkingDirectory sub -c 'Remove-Item -Recurse ..\\other'", [DELETE]],
  ["powershell", "pwsh -wd sub -c 'Remove-Item -Recurse ..\\other'", [DELETE]],
  ["powershell", "wsl --cd ~ rm -rf ../other", [DELETE]],
  ["powershell", "wsl rm -rf ../other", []],
  ["powershell", "pwsh -w hidden -c 'Remove-Item -Recurse ..\\other'", []],
  // Choice 53: while the folder is unknown, a recursive delete of any relative path counts
  ["bash", 'cd "$d" && rm -rf build', [DELETE]],
  ["powershell", "cd $env:TEMP; Remove-Item -Recurse build", [DELETE]],
  ["bash", "find . -execdir rm -rf x \\;", [DELETE]],
  ["bash", 'cd "$d" && rm -rf /tmp/y', []],
  ["bash", 'cd "$d" && rm -rf "$x/y"', []],
  ["bash", 'cd "$d" && rm -rf ~/y', []],
  ["bash", 'cd "$d" && rm build', []],
  ["powershell", "cd $env:TEMP; Remove-Item -Recurse C:\\work\\x\\build", []],
  // Choice 52: bash's ~+ is the current folder; ~- (the one before) and ~name (another's home) are known only when it runs
  ["bash", "rm -rf ~+", [DELETE]],
  ["bash", "rm -rf ~+/", [DELETE]],
  ["bash", "rm -rf ~-", [DELETE]],
  ["bash", "rm -rf ~u", [DELETE]],
  ["bash", "rm -rf ~u/", [DELETE]],
  ["bash", "cd ~- && rm -rf ../other", [DELETE]],
  ["bash", "rm -rf ~+/x", []],
  ["bash", "rm -rf ~u/x", []],
  ["bash", "cd ~+/sub && rm -rf ../other", []],
  // Choice 45: a target that is only a variable counts, as an empty or wrong value deletes the wrong folder
  ["bash", 'rm -rf "$d"', [DELETE]],
  ["bash", "rm -rf $d", [DELETE]],
  ["bash", 'rm -rf "${d}"', [DELETE]],
  ["bash", 'rm -rf "$d/"', [DELETE]],
  ["bash", 'rm -rf "$d/*"', [DELETE]],
  ["bash", "rm -rf $d/*", [DELETE]],
  ["bash", 'rm -rf "$S/.."', [DELETE]],
  ["bash", 'rm -rf "$S/a/../.."', [DELETE]],
  ["powershell", "Remove-Item -Recurse $d", [DELETE]],
  ["powershell", 'Remove-Item -Recurse "$d\\*"', [DELETE]],
  ["bash", 'rm -rf "$S/review"', []],
  ["bash", 'rm -rf "$S/a/../b"', []],
  ["powershell", "Remove-Item -Recurse $env:TEMP\\x", []],
  // Choice 52: one variable with a fallback, member, subscript or operator, a command substitution, or only variables
  ["bash", "rm -rf ${d:-/}", [DELETE]],
  ["bash", 'rm -rf "${d:-build}"', [DELETE]],
  ["bash", 'rm -rf "${d:?}"', [DELETE]],
  ["bash", 'rm -rf "${d[0]}"', [DELETE]],
  ["bash", 'rm -rf "${d%/*}/"', [DELETE]],
  ["bash", 'rm -rf "${a:-${b}}"', [DELETE]],
  ["bash", 'rm -rf "$@"', [DELETE]],
  ["bash", 'rm -rf "$*"', [DELETE]],
  ["bash", 'rm -rf "$1"', [DELETE]],
  ["bash", 'rm -rf "$(pwd)"', [DELETE]],
  ["bash", "rm -rf `pwd`", [DELETE]],
  ["bash", 'rm -rf "$(pwd)/"', [DELETE]],
  ["bash", 'rm -rf "$d/$e"', [DELETE]],
  ["bash", 'rm -rf "$d/$e/"', [DELETE]],
  ["bash", 'rm -rf "$d$e"', [DELETE]],
  ["bash", 'rm -rf "$HOME/$x"', [DELETE]],
  ["bash", 'rm -rf "$S/$e/.."', [DELETE]],
  ["powershell", "Remove-Item -Recurse $PWD.Path", [DELETE]],
  ["powershell", "Remove-Item -Recurse $d.FullName", [DELETE]],
  ["powershell", "Remove-Item -Recurse $d[0]", [DELETE]],
  ["powershell", "Remove-Item -Recurse $($d)", [DELETE]],
  ["powershell", "Remove-Item -Recurse $d\\$e", [DELETE]],
  ["bash", 'rm -rf "$S/$e/x"', []],
  ["bash", 'rm -rf "${d}.bak"', []],
  ["bash", 'rm -rf "$(pwd)/build"', []],
  ["powershell", "Remove-Item -Recurse $d.FullName\\x", []],
  // Choice 52: PowerShell's FileSystem:: paths, -Path:value and comma lists
  ["powershell", "Remove-Item -Recurse FileSystem::C:\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\u", [DELETE]],
  ["powershell", "Remove-Item -Recurse -Path:C:\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse -LiteralPath:C:\\work\\x", [DELETE]],
  ["powershell", "Remove-Item -Recurse:$true C:\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse C:\\,dist", [DELETE]],
  ["powershell", "Remove-Item -Recurse dist,C:\\", [DELETE]],
  ["powershell", "Remove-Item -Recurse -Path:dist,~", [DELETE]],
  // The FileSystem:: prefix is taken off before a target is read as climbing out of its folder
  ["powershell", "cd C:\\Users\\v; Remove-Item -Recurse FileSystem::..\\u", [DELETE]],
  ["powershell", "cd C:\\Users\\v; Remove-Item -Recurse Microsoft.PowerShell.Core\\FileSystem::..\\u", [DELETE]],
  // PowerShell's \x is on the current folder's drive
  ["powershell", "Remove-Item -Recurse \\Users", [DELETE]],
  ["powershell", "Remove-Item -Recurse \\work\\x", [DELETE]],
  ["powershell", "Remove-Item -Recurse /Users/u", [DELETE]],
  ["powershell", "cd D:\\y; Remove-Item -Recurse \\Users", [DELETE]],
  ["powershell", "cd $env:TEMP; Remove-Item -Recurse \\tmp\\x", [DELETE]],
  ["powershell", "Remove-Item -Recurse \\work\\x\\build", []],
  ["powershell", "cd D:\\y; Remove-Item -Recurse \\y\\build", []],
  ["powershell", "Remove-Item -Recurse:$false C:\\", []],
  ["powershell", "Remove-Item -Recurse dist,build", []],
  ["powershell", "Remove-Item -Recurse -Path:dist", []],
  ["bash", "rm -rf x,/", []], // bash's rm reads the comma as part of the name
  // Choice 52: BSD's and macOS's rm letters
  ["bash", "rm -rfP ~", [DELETE]],
  ["bash", "rm -Prf /", [DELETE]],
  ["bash", "rm -rfx /", [DELETE]],
  ["bash", "rm -dRvW /", [DELETE]],
  // Choice 52: cmd's *.* is every file, as * is
  ["powershell", "cmd /c del /s /q *.*", [DELETE]],
  ["powershell", "cmd /c del /s /q C:\\work\\x\\*.*", [DELETE]],
  ["powershell", "cmd /c del /s /q *.log", []],
  ["bash", "rm -rf *.*", []], // bash's *.* is only the names with a dot
  // Every built-in name of Remove-Item, cmd's del and erase with /s, and rm's long option written short
  ["powershell", "erase -Recurse C:\\", [DELETE]],
  ["powershell", "cmd /c del /s /q C:\\", [DELETE]],
  ["powershell", "cmd /c erase /s/q *", [DELETE]],
  ["bash", "rm --rec --force /", [DELETE]],
  ["powershell", "cmd /c del /s /q C:\\work\\x\\*.log", []],
  ["bash", "rm --verbose /", []],
  ["bash", "rm -rf node_modules", []],
  ["bash", "rm -rf /tmp/x/build", []],
  ["bash", "rm -rf ~/x", []],
  ["bash", "rm -f /", []],
  ["bash", "rm -- -r /", []],
  ["bash", "echo rm -rf /", []],
  ["powershell", "Remove-Item -Recurse .\\build", []],
  ["powershell", "Remove-Item -Force C:\\work\\x", []],
  ["powershell", "rd C:\\", []],

  // Permissions and system settings
  ["powershell", "icacls C:\\work\\x /grant u:F", [PERMS]],
  ["powershell", "takeown /f x", [PERMS]],
  ["powershell", "cacls x", [PERMS]],
  ["powershell", "Set-Acl -Path x -AclObject $a", [PERMS]],
  ["bash", "chmod -R 777 /tmp/x", [PERMS]],
  ["bash", "chmod -Rv 755 x", [PERMS]],
  ["bash", "chmod --recursive 755 x", [PERMS]],
  ["bash", "chown -R u /tmp/x", [PERMS]],
  ["powershell", "reg add HKCU\\Software\\x", [PERMS]],
  ["powershell", "Set-ItemProperty -Path HKLM:\\Software\\x -Name y -Value 1", [PERMS]],
  ["powershell", "set-itemproperty hkcu:\\x -Name y -Value 1", [PERMS]],
  ["powershell", "bcdedit /set x", [PERMS]],
  ["powershell", "Set-ExecutionPolicy Bypass", [PERMS]],
  ["powershell", "netsh advfirewall set allprofiles state off", [PERMS]],
  ["bash", "sudo ls", [PERMS]],
  ["powershell", "sudo --inline netstat -ab", [PERMS]],
  ["bash", "su -", [PERMS]],
  ["bash", "doas ls", [PERMS]],
  ["powershell", "runas /user:admin cmd", [PERMS]],
  ["powershell", "setx PATH x", [PERMS]],
  ["bash", "chmod --recur 755 x", [PERMS]],
  ["bash", "chown --rec u x", [PERMS]],
  ["powershell", "sp HKLM:\\Software\\x -Name y -Value 1", [PERMS]],
  ["powershell", "sudo run rm -rf /", [PERMS, DELETE]],
  ["powershell", "sudo run --inline netstat -ab", [PERMS]],
  ["powershell", "sudo config --enable normal", [PERMS]],
  // Choice 48: reg's changes and icacls's change switches warn; reg query and icacls with no change switch pass
  ["powershell", "reg delete HKCU\\Software\\x /f", [PERMS]],
  ["powershell", "reg import x.reg", [PERMS]],
  ["powershell", "reg restore HKLM\\x x.hiv", [PERMS]],
  ["powershell", "reg load HKLM\\x x.hiv", [PERMS]],
  ["powershell", "reg unload HKLM\\x", [PERMS]],
  ["powershell", "reg copy HKCU\\a HKCU\\b", [PERMS]],
  ["powershell", "icacls x /deny u:W", [PERMS]],
  ["powershell", "icacls x /grant:r u:F", [PERMS]],
  ["powershell", "icacls x /remove:g u", [PERMS]],
  ["powershell", "icacls x /reset /T", [PERMS]],
  ["powershell", "icacls x /setowner u", [PERMS]],
  ["powershell", "icacls x /inheritance:r", [PERMS]],
  ["powershell", "icacls x /setintegritylevel H", [PERMS]],
  ["powershell", "icacls C:\\work /restore acl.txt", [PERMS]],
  ["powershell", "icacls C:\\work /substitute a b /restore acl.txt", [PERMS]],
  ["powershell", "reg query HKLM\\Software\\x", []],
  ["powershell", "REG QUERY HKCU\\x /s", []],
  ["powershell", "icacls C:\\work\\x", []],
  ["powershell", "icacls C:\\work\\x /T /C /Q", []],
  ["powershell", "icacls x /save acl.txt /t", []],
  ["powershell", "icacls x /findsid u", []],
  ["powershell", "icacls x /verify /l", []],
  ["powershell", "icacls /?", []], // help only
  ["powershell", "reg /?", []],
  ["powershell", "reg query /?", []],
  ["powershell", "reg add /?", []],
  ["powershell", "reg", [PERMS]],
  ["powershell", 'reg add HKCU\\x /v a /d "/?"', [PERMS]], // only /? straight after reg or its subcommand is help
  ["powershell", "reg add HKCU\\x /?", [PERMS]],
  // Choice 52: the registry written as Registry::, as -Path:value, or in a comma list
  ["powershell", "Set-ItemProperty -Path Registry::HKEY_LOCAL_MACHINE\\Software\\x -Name y -Value 1", [PERMS]],
  ["powershell", "sp Microsoft.PowerShell.Core\\Registry::HKEY_CURRENT_USER\\x -Name y -Value 1", [PERMS]],
  ["powershell", "Set-ItemProperty -Path:HKLM:\\Software\\x -Name y -Value 1", [PERMS]],
  ["powershell", "Set-ItemProperty -Path x.txt,HKCU:\\x -Name y -Value 1", [PERMS]],
  ["bash", "chmod +x a.sh", []],
  ["bash", "chown u x", []],
  ["powershell", "Set-ItemProperty -Path .\\x.txt -Name IsReadOnly -Value $true", []],
  ["powershell", "Set-ItemProperty -Path:.\\x.txt -Name IsReadOnly -Value $true", []],

  // Stopping processes or the machine
  ["powershell", "taskkill /im node.exe /f", [STOP]],
  ["powershell", "Stop-Process -Name node", [STOP]],
  ["powershell", "stop-process -Id 5", [STOP]],
  ["bash", "kill 123", [STOP]],
  ["bash", "kill -0 123", [STOP]], // still matches: kill is named
  ["powershell", "kill -Id 5", [STOP]],
  ["bash", "pkill node", [STOP]],
  ["bash", "killall node", [STOP]],
  ["bash", "shutdown -h now", [STOP]],
  ["powershell", "shutdown /s /t 0", [STOP]],
  ["powershell", "C:\\Windows\\System32\\shutdown.exe /r", [STOP]],
  ["bash", "reboot", [STOP]],
  ["bash", "halt", [STOP]],
  ["bash", "poweroff", [STOP]],
  ["powershell", "Stop-Computer", [STOP]],
  ["powershell", "Restart-Computer -Force", [STOP]],
  ["bash", "systemctl stop nginx", [STOP]],
  ["bash", "systemctl reboot", [STOP]],
  ["bash", "systemctl poweroff", [STOP]],
  ["powershell", "wsl --shutdown", [STOP]],
  ["powershell", "wsl --terminate Ubuntu", [STOP]],
  ["powershell", "wsl -t Ubuntu", [STOP]],
  ["powershell", "spps -Name node", [STOP]],
  ["bash", "systemctl -H host stop x", [STOP]],
  ["bash", "systemctl --user stop x", [STOP]],
  ["powershell", "wsl -d Ubuntu --terminate", [STOP]],
  ["powershell", "wsl ~ --shutdown", [STOP]],
  ["bash", "systemctl halt", [STOP]], // choice 50
  ["bash", "systemctl kill nginx", [STOP]],
  ["bash", "systemctl status nginx", []],
  ["powershell", "wsl ls -t", []],
  ["powershell", "wsl -- ls --shutdown", []],
  ["powershell", "wsl -e ls -t", []],
  ["powershell", "wsl ls --unregister", []],
  ["powershell", "Get-Process node", []],

  // Rewriting or deleting git history
  ["bash", "git push --force", [GIT]],
  ["powershell", "git push -f origin main", [GIT]],
  ["bash", "git push -uf origin main", [GIT]],
  ["bash", "git push --force-with-lease", [GIT]],
  ["bash", "git push --force-with-lease=main:abc origin main", [GIT]],
  ["bash", "git push origin --delete x", [GIT]],
  ["bash", "git push -d origin x", [GIT]],
  ["bash", "git push origin :x", [GIT]],
  ["bash", "git push origin +main", [GIT]],
  ["bash", "git -C /tmp/x push --force", [GIT]],
  ["powershell", "& 'C:\\Program Files\\Git\\bin\\git.exe' push --force", [GIT]],
  ["bash", "git reset --hard", [GIT]],
  ["powershell", "git reset --hard HEAD~1", [GIT]],
  ["bash", "git clean -fd", [GIT]],
  ["bash", "git clean -df", [GIT]],
  ["bash", "git clean -f -d", [GIT]],
  ["powershell", "git clean -fdx", [GIT]],
  ["bash", "git checkout -- .", [GIT]],
  ["bash", "git checkout .", [GIT]],
  ["bash", "git restore .", [GIT]],
  ["bash", "git restore --staged --worktree .", [GIT]],
  ["bash", "git branch -D x", [GIT]],
  ["bash", "git branch --delete --force x", [GIT]],
  ["bash", "git filter-branch --tree-filter x", [GIT]],
  ["bash", "git filter-repo --path x", [GIT]],
  ["bash", "git rebase main", [GIT]],
  ["powershell", "git rebase -i HEAD~3", [GIT]],
  ["bash", "git -c a=b push -f", [GIT]],
  ["bash", "git push --forc", [GIT]],
  ["bash", "git push --del origin x", [GIT]],
  ["bash", "git push --force-with-lease --force-if-includes", [GIT]],
  ["bash", "git reset --ha", [GIT]],
  ["bash", "git clean --forc -d", [GIT]],
  ["bash", "git branch --delete --forc x", [GIT]],
  ["bash", "git branch --del --force x", [GIT]],
  ["bash", "git restore --stag --work .", [GIT]],
  // Choices 50-52: more arguments that rewrite or delete, and the look-only and finishing forms that pass
  ["bash", "git push --mirror origin", [GIT]],
  ["bash", "git push --prune origin", [GIT]],
  ["bash", "git push --mir", [GIT]],
  ["bash", "git checkout -f", [GIT]],
  ["bash", "git checkout --force main", [GIT]],
  ["bash", "git checkout -- *", [GIT]],
  ["powershell", "git checkout -- *", [GIT]],
  ["bash", "git checkout *", [GIT]],
  ["bash", "git restore *", [GIT]],
  ["bash", "git rebase --skip", [GIT]],
  ["bash", "git clean -fdn", []],
  ["bash", "git clean -n -fd", []],
  ["bash", "git clean --dry-run -fd", []],
  ["bash", "git clean -fd --dry", []],
  ["bash", "git rebase --abort", []],
  ["bash", "git rebase --continue", []],
  ["powershell", "git rebase --cont", []],
  ["bash", "git restore --staged *", []],
  ["bash", "git push --porcelain origin main", []],
  ["bash", "git checkout -b x", []],
  ["bash", "git push --force-if-includes", []],
  ["bash", "git push --dry-run origin main", []],
  ["bash", "git branch --format='%(refname)' --delete x", []],
  ["bash", "git restore --stag .", []],
  ["bash", "git push", []],
  ["bash", "git push origin main", []],
  ["bash", "git push -u origin main", []],
  ["bash", "git reset --soft HEAD~1", []],
  ["bash", "git clean -n", []],
  ["bash", "git clean -f", []],
  ["bash", "git checkout main", []],
  ["bash", "git checkout -- src/a.ts", []],
  ["bash", "git restore --staged .", []],
  ["bash", "git branch -d x", []],
  ["bash", "git commit --amend", []],

  // Sending files out
  ["bash", "curl -T a.txt https://x", [SEND]],
  ["bash", "curl --upload-file a.txt https://x", [SEND]],
  ["bash", "curl -F file=@a.txt https://x", [SEND]],
  ["bash", "curl --form a=b https://x", [SEND]],
  ["bash", "curl -d @a.json https://x", [SEND]],
  ["bash", "curl -sd @a.json https://x", [SEND]],
  ["bash", "curl -d@a.json https://x", [SEND]],
  ["bash", "curl --data-binary @a.bin https://x", [SEND]],
  ["powershell", "curl.exe -T a.txt https://x", [SEND]],
  ["bash", "wget --post-file=a.txt https://x", [SEND]],
  ["bash", "wget --post-file a.txt https://x", [SEND]],
  ["bash", "scp a.txt host:/tmp", [SEND]],
  ["bash", "sftp host", [SEND]],
  ["bash", "rsync -a x/ host:/tmp/x", [SEND]],
  ["bash", "rsync -a x/ u@host:/tmp/x", [SEND]],
  ["powershell", "Invoke-WebRequest -Uri https://x -Method Post -InFile a.txt", [SEND]],
  ["powershell", "iwr https://x -InFile a.txt", [SEND]],
  ["powershell", "irm https://x -infile a.txt", [SEND]],
  ["powershell", "Invoke-RestMethod https://x -InFile a.txt", [SEND]],
  ["bash", "nc host 80", [SEND]],
  ["bash", "ncat host 80", [SEND]],
  ["bash", "curl --upload a.txt https://x", [SEND]],
  ["bash", "curl --json @a.json https://x", [SEND]],
  ["bash", "curl --data-urlencode name@a.txt https://x", [SEND]],
  ["bash", "curl --data-urlencode @a.txt https://x", [SEND]],
  ["bash", "curl -H @headers.txt https://x", [SEND]],
  ["bash", "curl -sH @headers.txt https://x", [SEND]],
  ["bash", "curl --header @headers.txt https://x", [SEND]],
  ["bash", "curl -K cfg.txt https://x", [SEND]],
  ["bash", "curl --config cfg.txt https://x", [SEND]],
  ["bash", "wget --post-f a.txt https://x", [SEND]],
  ["powershell", "curl -InFile a.txt https://x", [SEND]], // Windows PowerShell 5.1's curl and wget name Invoke-WebRequest
  ["powershell", "wget https://x -inf a.txt", [SEND]],
  // Choice 50: wget's --body-file, and curl's --variable and --url-query reading a file, and its --expand-* options
  ["bash", "wget --method=PUT --body-file=a.txt https://x", [SEND]],
  ["bash", "wget --body-file a.txt https://x", [SEND]],
  ["bash", "curl --variable name@a.txt https://x", [SEND]],
  ["bash", "curl --variable @a.txt https://x", [SEND]],
  ["bash", "curl --var name@a.txt https://x", [SEND]],
  ["bash", "curl --url-query name@a.txt https://x", [SEND]],
  ["bash", "curl --expand-data '{{v}}' https://x", [SEND]],
  ["bash", "curl --expand-url 'https://x/{{v}}'", [SEND]],
  ["powershell", "curl.exe --variable name@a.txt https://x", [SEND]],
  ["bash", "wget --body-data 'a=b' https://x", []],
  ["bash", "curl --variable a=b@c https://x", []],
  ["bash", "curl --url-query a=b https://x", []],
  ["bash", "curl --url https://u@x", []],
  // Choice 51: a value glued to an option ends its letters; --form-string sends no file
  ["bash", "curl -uFred:pw https://x", []],
  ["bash", "curl -oFoo.zip https://x", []],
  ["bash", "curl -sSLoTx.zip https://x", []],
  ["bash", "curl --form-string 'a=@b' https://x", []],
  ["bash", "curl -sT a.txt https://x", [SEND]],
  ["bash", "curl -sKcfg.txt https://x", [SEND]],
  ["bash", "curl -I https://x", []],
  ["powershell", "curl -I https://x", []],
  ["bash", "curl --json '{\"a\":1}' https://x", []],
  ["bash", "curl --data-urlencode a=b@c https://x", []],
  // PR #9's review: a long option's value glued on after =
  ["bash", "curl --data-binary=@a.bin https://x", [SEND]],
  ["bash", "curl --json=@a.json https://x", [SEND]],
  ["bash", "curl --header=@headers.txt https://x", [SEND]],
  ["bash", "curl --data-urlencode=name@a.txt https://x", [SEND]],
  ["bash", "curl --variable=@a.txt https://x", [SEND]],
  ["bash", "curl --data-urlencode=a=b@c https://x", []],
  ["bash", "curl --data=a=b https://x", []],
  ["bash", "curl --url=https://u@x", []],
  ["bash", "curl -H 'X-A: b' https://x", []],
  ["bash", "curl https://x", []],
  ["bash", "curl -d 'a=b' https://x", []],
  ["bash", "curl -sSfL -o out.txt https://x", []],
  ["bash", "wget https://x", []],
  ["bash", "rsync -a x/ /tmp/y", []],
  ["bash", "rsync -a host:/tmp/x ./x", []],
  ["powershell", "iwr https://x -OutFile a.txt", []],
  ["powershell", "scp a.txt host:/tmp", [SEND]],

  // Installing software
  ["bash", "npm install express", [INSTALL]],
  ["powershell", "npm i -D vitest", [INSTALL]],
  ["bash", "npm add x", [INSTALL]],
  ["bash", "pnpm add x", [INSTALL]],
  ["bash", "pnpm install x", [INSTALL]],
  ["bash", "yarn add x", [INSTALL]],
  ["bash", "bun add x", [INSTALL]],
  ["bash", "bun install x", [INSTALL]],
  ["bash", "bun i x", [INSTALL]],
  ["bash", "npx vitest", [INSTALL]],
  ["bash", "pnpm dlx x", [INSTALL]],
  ["bash", "yarn dlx x", [INSTALL]],
  ["bash", "bunx x", [INSTALL]],
  ["bash", "pip install requests", [INSTALL]],
  ["powershell", "pip3 install -U requests", [INSTALL]],
  ["bash", "pip install -r requirements.txt requests", [INSTALL]],
  ["bash", "uv pip install requests", [INSTALL]],
  ["bash", "uv add x", [INSTALL]],
  ["bash", "uvx ruff", [INSTALL]],
  ["bash", "pipx install x", [INSTALL]],
  ["bash", "cargo install ripgrep", [INSTALL]],
  ["bash", "go install x@latest", [INSTALL]],
  ["bash", "gem install x", [INSTALL]],
  ["powershell", "winget install x", [INSTALL]],
  ["powershell", "choco install x", [INSTALL]],
  ["powershell", "scoop install x", [INSTALL]],
  ["bash", "apt install x", [INSTALL]],
  ["bash", "apt-get install x", [INSTALL]],
  ["bash", "brew install x", [INSTALL]],
  ["bash", "dnf install x", [INSTALL]],
  ["bash", "yum install x", [INSTALL]],
  ["bash", "pacman -S x", [INSTALL]],
  ["powershell", "Install-Module x", [INSTALL]],
  ["powershell", "Install-Package x", [INSTALL]],
  ["bash", "npm isntall x", [INSTALL]], // npm's own spellings of install
  ["bash", "npm in x", [INSTALL]],
  ["bash", "npm instal x", [INSTALL]],
  ["bash", "bun a x", [INSTALL]],
  ["bash", "npm --prefix d install x", [INSTALL]],
  ["bash", "npm -g install x", [INSTALL]],
  ["bash", "npm exec vitest", [INSTALL]],
  ["bash", "npm x -- vitest", [INSTALL]],
  ["bash", "npm exec --package=x -- y", [INSTALL]],
  ["bash", "bun x cowsay", [INSTALL]],
  ["bash", "python -m pip install x", [INSTALL]],
  ["bash", "python3 -mpip install x", [INSTALL]],
  ["powershell", "py -3 -m pip install x", [INSTALL]],
  ["bash", "pip --proxy p install x", [INSTALL]],
  ["bash", "pip install --index-url https://x y", [INSTALL]],
  ["bash", "uv --directory d pip install x", [INSTALL]],
  ["bash", "cargo +nightly install x", [INSTALL]],
  ["powershell", "inmo x", [INSTALL]],
  // Choice 50: more ways to install
  ["bash", "pnpx x", [INSTALL]],
  ["bash", "yarn global add x", [INSTALL]],
  ["bash", "yarn workspace app add x", [INSTALL]],
  ["bash", "npm it x", [INSTALL]],
  ["bash", "npm install-test x", [INSTALL]],
  ["bash", "uv tool install ruff", [INSTALL]],
  ["bash", "uv tool run ruff", [INSTALL]],
  ["powershell", "uvx ruff", [INSTALL]],
  ["powershell", "npx vitest", [INSTALL]],
  // Choice 52: Windows's .cmd, .bat and .ps1 names, also under cmd /c
  ["powershell", "npm.cmd install express", [INSTALL]],
  ["powershell", "cmd /c npx.cmd vitest", [INSTALL]],
  ["powershell", "yarn.cmd add x", [INSTALL]],
  ["powershell", "cmd /c yarn.bat add x", [INSTALL]],
  ["powershell", "pnpm.ps1 add x", [INSTALL]],
  // Choice 51: an option's value is not a package
  ["bash", "npm install --prefix client", []],
  ["bash", "npm install --omit dev", []],
  ["bash", "npm i --loglevel http", []],
  ["bash", "npm i -w app", []],
  ["bash", "pnpm install --filter app", []],
  ["bash", "pnpm i -C sub", []],
  ["bash", "bun install --cwd sub", []],
  ["bash", "yarn install --cwd sub", []],
  ["bash", "npm it", []],
  ["bash", "yarn global list", []],
  ["bash", "uv tool list", []],
  ["bash", "npm install --prefix client express", [INSTALL]],
  ["bash", "pnpm add --filter app x", [INSTALL]],
  ["bash", "npm install --pre x", [INSTALL]], // only a name in full has its value skipped
  ["bash", "npm --prefix d install", []],
  ["bash", "npm --prefix d run build", []],
  ["bash", "npm run add", []],
  ["bash", "npm exec", []],
  ["bash", "pnpm exec vitest", []], // pnpm exec runs what node_modules/.bin holds
  ["bash", "python -m pip list", []],
  ["bash", "python3 -m pip install -r requirements.txt", []],
  ["bash", "pip install --index-url https://x -r requirements.txt", []],
  ["bash", "pip install -i https://x --extra-index-url https://y -r requirements.txt", []],
  ["bash", "pip install --target d --prefix p -c c.txt -r requirements.txt", []],
  // A start of an option's name is not skipped with its value, as it may be a flag such as --pre: the word after it asks
  ["bash", "pip install --index https://x -r requirements.txt", [INSTALL]],
  ["bash", "pip install --pre x", [INSTALL]],
  ["bash", "constructor x", []],
  ["bash", "toString", []],
  ["bash", "npm install", []],
  ["powershell", "npm i", []],
  ["bash", "npm install --save-dev", []],
  ["bash", "npm ci", []],
  ["bash", "pnpm install", []],
  ["bash", "yarn install", []],
  ["bash", "yarn", []],
  ["bash", "bun install", []],
  ["bash", "pip install -r requirements.txt", []],
  ["bash", "pip install -r requirements.txt -c constraints.txt", []],
  ["bash", "uv pip install -r requirements.txt", []],
  ["bash", "uv sync", []],
  ["bash", "npm run build", []],
  ["bash", "cargo build", []],
  ["bash", "go build ./...", []],

  // Downloading and running code (choice 44); piped into a shell, it is unreadable
  ["bash", "deno run https://x/a.ts", [RUN]],
  ["bash", "deno run -A --reload https://x/a.ts", [RUN]],
  ["powershell", "deno https://x/a.ts", [RUN]],
  ["bash", "deno install -g -n a https://x/a.ts", [RUN]],
  ["bash", "deno x https://x/a.ts", [RUN]],
  ["bash", "node https://x/a.js", [RUN]],
  ["powershell", "python HTTPS://x/a.py", [RUN]],
  ["bash", "python3 -u http://x/a.py", [RUN]],
  ["bash", "bun https://x/a.ts", [RUN]],
  ["bash", "bun run https://x/a.ts", [RUN]],
  ["bash", "uv run https://x/a.py", [RUN]],
  ["bash", "sudo ruby https://x/a.rb", [PERMS, RUN]],
  ["bash", "deno run npm:cowsay", [RUN]], // choice 50: a package from npm or jsr
  ["bash", "deno run -A jsr:@std/x", [RUN]],
  ["powershell", "deno npm:cowsay", [RUN]],
  ["bash", "deno x npm:cowsay", [RUN]],
  ["bash", "deno install -g npm:cowsay", [RUN]],
  ["bash", "deno run main.ts", []],
  ["bash", "deno install", []],
  ["bash", "node a.js https://x", []],
  ["bash", "python -m http.server", []],
  ["bash", 'python -c "print(1)" https://x', []],

  // Acting outside the machine
  ["bash", "gh pr merge 5", [OUTSIDE]],
  ["powershell", "gh repo delete x", [OUTSIDE]],
  ["bash", "gh release delete v1", [OUTSIDE]],
  ["bash", "gh api -X DELETE repos/x", [OUTSIDE]],
  ["bash", "gh api --method DELETE repos/x", [OUTSIDE]],
  ["bash", "gh api --method=delete repos/x", [OUTSIDE]],
  ["bash", "terraform apply", [OUTSIDE]],
  ["bash", "terraform -chdir=x destroy", [OUTSIDE]],
  ["bash", "pulumi up", [OUTSIDE]],
  ["bash", "pulumi destroy", [OUTSIDE]],
  ["bash", "kubectl delete pod x", [OUTSIDE]],
  ["bash", "kubectl -n ns apply -f x.yaml", [OUTSIDE]],
  ["bash", "helm uninstall x", [OUTSIDE]],
  ["bash", "aws s3 rm s3://b/x", [OUTSIDE]],
  ["bash", "aws ec2 terminate-instances --instance-ids i-1", [OUTSIDE]],
  ["bash", "aws s3api delete-bucket --bucket b", [OUTSIDE]],
  ["bash", "gcloud compute instances delete x", [OUTSIDE]],
  ["powershell", "az group delete -n x", [OUTSIDE]],
  ["bash", "docker push x", [OUTSIDE]],
  ["bash", "npm publish", [OUTSIDE]],
  ["bash", "helm delete x", [OUTSIDE]],
  ["bash", "helm del x", [OUTSIDE]],
  ["bash", "helm un x", [OUTSIDE]],
  ["bash", "aws s3 sync . s3://b --delete", [OUTSIDE]],
  ["bash", "aws s3 rm --recursive s3://b", [OUTSIDE]],
  ["bash", "docker --context c push x", [OUTSIDE]],
  ["bash", "docker -H host push x", [OUTSIDE]],
  ["bash", "pulumi -C dir up", [OUTSIDE]],
  ["bash", "terraform -chdir=x apply", [OUTSIDE]],
  ["bash", "npm --registry r publish", [OUTSIDE]],
  // Choice 50: the table's other arguments
  ["bash", "aws s3 rb s3://b", [OUTSIDE]],
  ["bash", "aws s3 rb --force s3://b", [OUTSIDE]],
  ["bash", "aws cloudformation delete-stack --stack-name x", [OUTSIDE]],
  ["bash", "aws --region us-east-1 s3 rm s3://b/x", [OUTSIDE]],
  ["bash", "aws --debug s3 rm s3://b/x", [OUTSIDE]],
  ["bash", "aws s3 --region r rm s3://b/x", [OUTSIDE]],
  ["bash", "docker image push x", [OUTSIDE]],
  ["bash", "docker compose push", [OUTSIDE]],
  ["bash", "docker compose -f x.yml push", [OUTSIDE]],
  ["bash", "docker buildx build --push .", [OUTSIDE]],
  ["bash", "docker buildx bake --push", [OUTSIDE]],
  ["bash", "docker build --push=true .", [OUTSIDE]],
  ["bash", "docker-compose push", [OUTSIDE]],
  ["bash", "gh issue delete 5", [OUTSIDE]],
  ["bash", "gh gist delete x", [OUTSIDE]],
  ["bash", "gh secret delete X", [OUTSIDE]],
  ["bash", "gh secret remove X", [OUTSIDE]],
  ["bash", "gh variable delete X", [OUTSIDE]],
  ["bash", "gh label delete x", [OUTSIDE]],
  ["bash", "gh run delete 1", [OUTSIDE]],
  ["bash", "gh cache delete x", [OUTSIDE]],
  ["bash", "gh ssh-key delete 1", [OUTSIDE]],
  ["bash", "gh gpg-key delete 1", [OUTSIDE]],
  ["bash", "gh codespace delete -c x", [OUTSIDE]],
  ["bash", "gh cs delete -c x", [OUTSIDE]],
  ["bash", "gh project delete 1", [OUTSIDE]],
  ["bash", "gh project item-delete 1", [OUTSIDE]],
  ["bash", "gh project field-delete --id x", [OUTSIDE]],
  ["bash", "gh repo deploy-key delete 1", [OUTSIDE]],
  ["bash", "gh repo autolink delete 1", [OUTSIDE]],
  ["bash", "gh release delete-asset v1 a.zip", [OUTSIDE]],
  ["bash", "gh -R o/r issue delete 5", [OUTSIDE]],
  ["bash", "pnpm publish", [OUTSIDE]],
  ["bash", "yarn publish", [OUTSIDE]],
  ["bash", "yarn npm publish", [OUTSIDE]],
  ["bash", "bun publish", [OUTSIDE]],
  ["bash", "pulumi update", [OUTSIDE]],
  ["bash", "pulumi down", [OUTSIDE]],
  ["bash", "helm -n ns uninstall x", [OUTSIDE]],
  ["powershell", "docker push x", [OUTSIDE]],
  ["powershell", "terraform apply", [OUTSIDE]],
  ["powershell", "kubectl delete pod x", [OUTSIDE]],
  ["powershell", "npm publish", [OUTSIDE]],
  ["powershell", "npm.ps1 publish", [OUTSIDE]],
  // Choice 51: only aws's operation name counts as a delete, and only helm's subcommand as un
  ["bash", "aws s3 cp deleted.txt s3://b/", []],
  ["bash", "aws cloudformation describe-stacks --stack-name delete-test", []],
  ["bash", "aws --profile delete s3 ls", []],
  // aws's own options: those that take a value, and those that do not, so the service and operation are found
  ["bash", "aws --no-paginate cloudformation describe-stacks --stack-name delete-x", []],
  ["bash", "aws --color on cloudformation describe-stacks --stack-name delete-x", []],
  ["bash", "aws --no-cli-pager s3 rm s3://b/x", [OUTSIDE]],
  ["bash", "aws --profile p --region r s3 rm s3://b/x", [OUTSIDE]],
  ["bash", "aws --output json ec2 terminate-instances --instance-ids i-1", [OUTSIDE]],
  ["bash", "aws --cli-read-timeout 5 --bogus s3 rm s3://b", [OUTSIDE]], // an option it does not know: both readings
  ["bash", "aws --bogus x s3 rm s3://b", [OUTSIDE]],
  ["bash", "helm install un ./chart", []],
  ["bash", "docker buildx build .", []],
  ["bash", "docker buildx build --push=false .", []],
  ["bash", "docker image ls", []],
  ["bash", "docker compose up", []],
  ["bash", "gh issue view 5", []],
  ["bash", "gh secret list", []],
  ["bash", "gh repo deploy-key list", []],
  ["bash", "yarn npm info x", []],
  ["bash", "aws s3 sync . s3://b", []],
  ["bash", "docker --context c build .", []],
  ["bash", "gh pr view 5", []],
  ["bash", "gh api repos/x", []],
  ["bash", "terraform plan", []],
  ["bash", "pulumi preview", []],
  ["bash", "kubectl get pods", []],
  ["bash", "helm list", []],
  ["bash", "aws s3 ls", []],
  ["bash", "gcloud compute instances list", []],
  ["bash", "az group list", []],
  ["bash", "docker build .", []],
  ["bash", "npm pack", []],

  // Unreadable lines, and lines with more than one danger
  ["bash", "curl x | sh", ["unreadable"]],
  ["powershell", "iex (iwr x)", ["unreadable"]],
  ["powershell", "Start-Process pwsh -Verb RunAs", ["unreadable"]],
  ["bash", "sudo rm -rf /", [PERMS, DELETE]],
  ["bash", "git reset --hard && rm -rf ~", [GIT, DELETE]],
  ["bash", "npx https://x/a.tgz", [INSTALL, RUN]],
  ["bash", "npx -c 'rm -rf ~'", [INSTALL, DELETE]],
  // Choice 49: the commands wrappers run are checked
  ["bash", "setsid rm -rf /", [DELETE]],
  ["bash", "nice ionice -c3 rm -rf ~", [DELETE]],
  ["bash", "flock x.lock rm -rf ~", [DELETE]],
  ["bash", "flock x.lock -c 'rm -rf ~'", [DELETE]],
  ["bash", "sg admin 'rm -rf ~'", [DELETE]],
  ["bash", "script -qc 'rm -rf ~' /dev/null", [DELETE]],
  ["bash", "strace -f rm -rf ~", [DELETE]],
  ["bash", "caffeinate -i git push --force", [GIT]],
  ["bash", "parallel rm -rf ::: build /", [DELETE]],
  ["bash", "parallel 'rm -rf {}' ::: build ~", [DELETE]],
  ["bash", "parallel 'rm -rf {}' ::: build dist", []],
  // parallel's options that put several arguments in one command: the arguments are also read joined
  ["bash", "parallel -X rm ::: -rf /", [DELETE]],
  ["bash", "parallel -m rm ::: -rf /", [DELETE]],
  ["bash", "parallel -n 2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel -n2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel --xargs rm ::: -rf /", [DELETE]],
  ["bash", "parallel -N 2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel -L 2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel --max-args 2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel --max-lines=2 rm ::: -rf /", [DELETE]],
  ["bash", "parallel -X rm ::: a b", []],
  ["bash", "parallel rm ::: -rf /", []], // each argument alone: rm -rf, and rm /
  ["bash", "ls -la", []],
  ["bash", "", []],
];

describe("dangers", () => {
  it.each(TABLE)("%s: %j", (shell, line, expected) => {
    expect(dangers(line, shell === "bash" ? BASH : PS).map((d) => d.kind)).toEqual(expected);
  });

  it("gives each danger the matched command's own text", () => {
    expect(dangers("FOO=1 rm -rf ~ > out.txt && ls", BASH)).toEqual([{ kind: DELETE, command: "FOO=1 rm -rf ~ > out.txt" }]);
    expect(dangers("sudo rm -rf /", BASH)).toEqual([
      { kind: PERMS, command: "sudo rm -rf /" },
      { kind: DELETE, command: "rm -rf /" },
    ]);
    expect(dangers("env -i rm -rf  ~ 2>&1", BASH)).toEqual([{ kind: DELETE, command: "rm -rf  ~" }]);
  });

  it("gives an unreadable line one danger, holding the reason", () => {
    expect(dangers("curl x | sh", BASH)).toEqual([{ kind: "unreadable", command: "text piped into a shell" }]);
  });

  it("takes the project's root from the context, as /work in the box", () => {
    expect(dangers("rm -rf /work/", BOX).map((d) => d.kind)).toEqual([DELETE]);
    expect(dangers("rm -rf /work/./", BOX).map((d) => d.kind)).toEqual([DELETE]);
    expect(dangers("rm -rf src/../..", BOX).map((d) => d.kind)).toEqual([DELETE]);
    expect(dangers("rm -rf src/../build", BOX)).toEqual([]);
    expect(dangers("rm -rf /work", BASH)).toEqual([]);
    expect(dangers("rm -rf /tmp/x", BOX)).toEqual([]);
  });

  it("compares Windows paths without case, and others with it", () => {
    expect(dangers("rm -rf /TMP/X", BASH)).toEqual([]);
    expect(dangers("Remove-Item -Recurse C:\\USERS\\U", PS).map((d) => d.kind)).toEqual([DELETE]);
  });

  // Choice 52: Git Bash's /c/... is C:\... when the project's root is on Windows. Paths off Windows keep their case.
  it("reads Git Bash's /c/... as C:\\... on a Windows root", () => {
    const kinds = (line: string) => dangers(line, GIT_BASH).map((d) => d.kind);
    expect(kinds("rm -rf /c/")).toEqual([DELETE]);
    expect(kinds("rm -rf /c")).toEqual([DELETE]);
    expect(kinds("rm -rf /C/Users/u")).toEqual([DELETE]);
    expect(kinds("rm -rf ..")).toEqual([DELETE]);
    expect(kinds("cd /c/work && rm -rf x")).toEqual([DELETE]);
    expect(kinds("cd .. && cd .. && rm -rf work")).toEqual([DELETE]);
    expect(kinds("rm -rf /c/work/x/build")).toEqual([]);
    expect(kinds("rm -rf build")).toEqual([]);
    expect(kinds("rm -rf /cd")).toEqual([]);
  });

  it("names every kind it can find in KINDS", () => {
    const found = new Set(TABLE.flatMap(([, , kinds]) => kinds));
    expect([...found].filter((k) => k !== "unreadable").sort()).toEqual([...KINDS].sort());
  });
});

// Choice 47: npx of a program the project holds passes, without downloading; the check is given, so no folder is read.
describe("npx of a program the project has", () => {
  const looked: string[] = [];
  const holding = (...files: string[]) => (file: string) => {
    looked.push(file);
    return files.includes(file);
  };
  const kinds = (line: string, ctx: Context) => dangers(line, ctx).map((d) => d.kind);
  const bash = (...files: string[]): Context => ({ ...BASH, has: holding(...files) });
  const ps = (...files: string[]): Context => ({ ...PS, has: holding(...files) });

  it("passes a plain name the project's node_modules/.bin holds, as itself or as .cmd", () => {
    looked.length = 0;
    expect(kinds("npx vitest run", bash("/tmp/x/node_modules/.bin/vitest"))).toEqual([]);
    expect(looked).toEqual(["/tmp/x/node_modules/.bin/vitest"]);
    expect(kinds("npx vitest", ps("C:\\work\\x\\node_modules\\.bin\\vitest.cmd"))).toEqual([]);
    expect(kinds("npx.cmd vitest", ps("C:\\work\\x\\node_modules\\.bin\\vitest"))).toEqual([]);
    expect(kinds("npx -y --loglevel warn vitest", bash("/tmp/x/node_modules/.bin/vitest"))).toEqual([]);
    expect(kinds("npx -w app vitest", bash("/tmp/x/node_modules/.bin/vitest"))).toEqual([]);
    expect(kinds("npx -- vitest", bash("/tmp/x/node_modules/.bin/vitest"))).toEqual([]);
  });

  it("asks for a version, a package, shell text, another folder, the global one, or a name it does not hold", () => {
    const has = bash("/tmp/x/node_modules/.bin/vitest", "/tmp/x/node_modules/.bin/vitest@1");
    expect(kinds("npx vitest@1", has)).toEqual([INSTALL]);
    expect(kinds("npx -p vitest vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx --package=vitest vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx -yp vitest vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx --prefix d vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx -g vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx @scope/vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx ../vitest", has)).toEqual([INSTALL]);
    expect(kinds("npx tsc", has)).toEqual([INSTALL]);
    expect(kinds("npx", has)).toEqual([INSTALL]);
  });

  it("looks in every folder the line may run in, and asks when it is unknown", () => {
    const has = bash("/tmp/x/node_modules/.bin/vitest");
    expect(kinds("cd sub && npx vitest", has)).toEqual([INSTALL]);
    expect(kinds("cd sub && npx vitest", bash("/tmp/x/node_modules/.bin/vitest", "/tmp/x/sub/node_modules/.bin/vitest"))).toEqual([]);
    expect(kinds('cd "$d" && npx vitest', has)).toEqual([INSTALL]);
  });
});

// Task 4 and choice 5: the user's own rules from settings.json, a command's first words added, and kinds switched off.
describe("the user's own rules", () => {
  const OWN = "your own rule: make deploy";
  const own = (add: string[], off: UserRules["off"] = []): UserRules => ({ add, off });
  const kinds = (line: string, ctx: Context, rules: UserRules) => dangers(line, ctx, rules).map((d) => d.kind);

  it("matches an added rule on a command's first words, word by word, giving the command's own text", () => {
    const rules = own(["make deploy"]);
    expect(dangers("make deploy", BASH, rules)).toEqual([{ kind: OWN, command: "make deploy" }]);
    expect(dangers("make deploy --now", BASH, rules)).toEqual([{ kind: OWN, command: "make deploy --now" }]);
    expect(dangers("cd sub && make deploy > out.txt", BASH, rules)).toEqual([{ kind: OWN, command: "make deploy > out.txt" }]);
    expect(kinds("bash -c 'make deploy'", BASH, rules)).toEqual([OWN]);
    expect(kinds("make  'deploy'", BASH, rules)).toEqual([OWN]); // words, with their quotes taken off
  });

  it("passes a near miss of an added rule", () => {
    const rules = own(["make deploy"]);
    for (const line of ["make", "make build", "make deployment", "make build deploy", "echo make deploy", "remake deploy", "make-deploy"]) {
      expect(kinds(line, BASH, rules)).toEqual([]);
    }
  });

  // The first word as the table's rules read it: without its folder, .exe or .cmd, and without case everywhere (choice 4).
  it("reads an added rule's first word as the table's rules do, and on Windows the rest without case too", () => {
    const rules = own(["make deploy"]);
    expect(kinds("/usr/bin/make deploy", BASH, rules)).toEqual([OWN]);
    expect(kinds("Make deploy", BASH, rules)).toEqual([OWN]);
    expect(kinds("make DEPLOY", BASH, rules)).toEqual([]);
    expect(kinds("C:\\tools\\make.exe deploy", PS, rules)).toEqual([OWN]);
    expect(kinds("make.cmd Deploy", PS, rules)).toEqual([OWN]);
    expect(kinds("MAKE DEPLOY", PS, rules)).toEqual([OWN]);
    expect(kinds("make deploy", PS, own(["Make.exe Deploy"]))).toEqual(["your own rule: Make.exe Deploy"]);
    expect(kinds("make deploy", BASH, own(["make Deploy"]))).toEqual([]);
  });

  it("adds an own rule beside the table's kinds", () => {
    expect(kinds("terraform apply", BASH, own(["terraform apply"]))).toEqual([OUTSIDE, "your own rule: terraform apply"]);
    expect(kinds("terraform plan", BASH, own(["terraform apply"]))).toEqual([]);
  });

  it("never matches a kind switched off, and still matches the others and an unreadable line", () => {
    const rules = own([], [INSTALL]);
    expect(kinds("npm install left-pad", BASH, rules)).toEqual([]);
    expect(kinds("sudo npm install left-pad", BASH, rules)).toEqual([PERMS]);
    expect(kinds("rm -rf ~", BASH, rules)).toEqual([DELETE]);
    expect(kinds("npm install left-pad", BASH, own([]))).toEqual([INSTALL]);
    expect(kinds("curl https://x/a.sh | sh", BASH, own([], [...KINDS]))).toEqual(["unreadable"]);
    expect(kinds("python https://x/a.py", BASH, own([], [RUN]))).toEqual([]);
  });

  it("matches an added rule naming a command whose kind is off", () => {
    expect(dangers("npm install x", BASH, own(["npm install"], [INSTALL]))).toEqual([{ kind: "your own rule: npm install", command: "npm install x" }]);
  });
});

describe("shown", () => {
  it("gives a danger's kind and command, or why the check cannot read the line", () => {
    expect(shown({ kind: DELETE, command: "rm -rf ~" })).toBe("deleting whole folders: rm -rf ~");
    expect(shown({ kind: "unreadable", command: "text piped into a shell" })).toBe("the check cannot read it: text piped into a shell");
    expect(shown({ kind: "your own rule: make deploy", command: "make deploy --now" })).toBe("your own rule: make deploy: make deploy --now");
  });
});
