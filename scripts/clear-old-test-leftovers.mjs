// A one-off script the user runs once, on their own PC, to clear the folders old test runs left in Temp (cleanup plan,
// step 21): `node scripts/clear-old-test-leftovers.mjs`. It lists Temp once, shows the test folders it found (count,
// total size, oldest and newest dates) and the names it is not sure of, and asks. Only a `y` deletes anything.
//
// Which names: each prefix the tests at 552f8e5 pass to their folder-making calls (a git grep at that commit, in step
// 21's report), followed by exactly the six letters or digits mkdtemp adds: the whole name and nothing else. Left off:
// `tachi-editor-lookup-` (the user's choice). The names Tachikoma itself makes in Temp (`tachi-editor-`,
// `tachi-build-`, `tachikoma-proxy-`) match no pattern here. A name that starts with `tachi` and is on no pattern, or
// a listed name that Temp's listing shows as a link or a file, is "not sure": shown, never touched. Nothing whose name
// does not start with `tachi` is looked at.
//
// The cut-off: only folders last changed before the cleanup build's start, 2026-11-25T05:48:31+11:00 (build-step-1.md
// in the build's run folder); the tests remove the folders they have made since.
//
// Deleting: one folder after another, through the tests' remover (tests/removeTree.mjs), with no retry, as an old
// folder nothing uses needs none. The type of each folder comes from the script's one listing of Temp, handed to the
// remover, so Temp is not listed again for each folder. What the remover gives back as left is printed with its
// reason and stays.
//
// Known limit, accepted by the user: the remover finds its way by path. A folder swapped for a link between the
// script's listing and its delete, or a folder inside swapped while the script deletes there, is not seen, and
// deletes can land behind the link.

import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { tryRemoveTree } from "../tests/removeTree.mjs";

export const PREFIXES = [
  "tachi editor ", "tachi-", "tachi-8d-throwaway-test-", "tachi-access-", "tachi-answers-", "tachi-app-data-",
  "tachi-app-hook-", "tachi-app-idle-copy-", "tachi-app-mcp-", "tachi-app-memory-", "tachi-app-notify-",
  "tachi-app-notify-copy-", "tachi-app-switch-", "tachi-apply-", "tachi-asked-", "tachi-box-", "tachi-boxws-",
  "tachi-built-", "tachi-case-", "tachi-chg-", "tachi-cli-", "tachi-cli-box-", "tachi-cli-copy-", "tachi-cli-docker-",
  "tachi-cli-drop-", "tachi-cli-e2e-", "tachi-cli-git-", "tachi-cli-home-", "tachi-cli-hook-", "tachi-cli-mcp-",
  "tachi-cli-memory-", "tachi-cli-permission-", "tachi-cli-prot-", "tachi-cli-review-", "tachi-cli-saved-",
  "tachi-cli-wait-", "tachi-client-", "tachi-clilib-", "tachi-clilib-instr-", "tachi-clilib-mcp-", "tachi-clipboard-",
  "tachi-copies-", "tachi-copy-", "tachi-data-", "tachi-git-", "tachi-gitconfig-", "tachi-helper-", "tachi-history-",
  "tachi-home-", "tachi-hook-", "tachi-hooks-", "tachi-hooks-mcp-", "tachi-hub-", "tachi-image-", "tachi-install-",
  "tachi-install-path-", "tachi-keychain-", "tachi-leave-", "tachi-lessonask-", "tachi-lessons-", "tachi-livelink-",
  "tachi-lock-", "tachi-login-", "tachi-mcp-", "tachi-mcp-auth-", "tachi-mcp-box-", "tachi-mcp-config-",
  "tachi-mcp-forms-", "tachi-mcp-search-", "tachi-mcp-server-", "tachi-mcp-servers-", "tachi-mcp-tools-",
  "tachi-mcpbox-", "tachi-mcpprogram-", "tachi-memory-", "tachi-memtools-", "tachi-models-", "tachi-mounts-",
  "tachi-notes-", "tachi-onpath-", "tachi-oslock-", "tachi-outside-", "tachi-paste-", "tachi-pictures-",
  "tachi-pretool-", "tachi-private-", "tachi-protected-", "tachi-proxy-test-", "tachi-psmodules-", "tachi-recall-",
  "tachi-reg-", "tachi-room-", "tachi-rvw-", "tachi-saver-", "tachi-saving-", "tachi-session-", "tachi-sessions-",
  "tachi-settings-", "tachi-setup-", "tachi-share-", "tachi-shorten-", "tachi-sites-launch-", "tachi-sites-real-",
  "tachi-sites-test-", "tachi-sites-work-", "tachi-snapshot-", "tachi-store-", "tachi-tasks-", "tachi-tasks-hook-",
  "tachi-tasks-mcp-", "tachi-terminal-", "tachi-transcript-", "tachi-unreadable-", "tachi-watch-",
];

const CUTOFF = Date.parse("2026-11-25T05:48:31+11:00");
const CUTOFF_SHOWN = "2026-11-25 05:48 (+11:00)";
const SIX = /^[A-Za-z0-9]{6}$/;

const isTestName = (name) =>
  PREFIXES.some((p) => name.length === p.length + 6 && name.startsWith(p) && SIX.test(name.slice(p.length)));
// A "not sure" name's group: the name up to its last `-` or space, or the whole name when it has neither.
const group = (name) => name.slice(0, Math.max(name.lastIndexOf("-"), name.lastIndexOf(" ")) + 1) || name;
const two = (n) => String(n).padStart(2, "0");
const date = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
const count = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
function size(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return i === 0 ? `${count(n)} B` : `${n.toFixed(1)} ${units[i]}`;
}

// The bytes in the files under `dir`, types read from listings: a link is not entered and adds nothing, as a status
// call on it could follow it.
async function bytesIn(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    total += e.isDirectory() ? await bytesIn(p) : (await lstat(p)).size;
  }
  return total;
}

// The script's work: `temp` is the folder to clear, `ask` asks the one question, `print` writes one line.
export async function clearOldTestLeftovers({ temp, ask, print }) {
  const test = [];
  let late = 0;
  const groups = new Map();
  const others = [];
  for (const e of await readdir(temp, { withFileTypes: true })) {
    if (!e.name.startsWith("tachi")) continue;
    if (e.isSymbolicLink() || !e.isDirectory()) {
      others.push({ key: e.name, text: `${e.isSymbolicLink() ? "a link" : "a file"}, not a folder` });
      continue;
    }
    const changed = (await lstat(path.join(temp, e.name))).mtimeMs;
    if (!isTestName(e.name)) {
      const g = groups.get(group(e.name)) ?? { n: 0, first: changed, last: changed };
      groups.set(group(e.name), { n: g.n + 1, first: Math.min(g.first, changed), last: Math.max(g.last, changed) });
    } else if (changed < CUTOFF) test.push({ name: e.name, changed });
    else late++;
  }

  print(`Old test folders in Temp (${temp})`);
  print(`Counted only if last changed before ${CUTOFF_SHOWN}.`);
  print("");
  print(`Test folders to delete: ${count(test.length)}`);
  if (test.length > 0) {
    let bytes = 0;
    for (const t of test) bytes += await bytesIn(path.join(temp, t.name));
    print(`  Total size: ${size(bytes)}`);
    print(`  Oldest: ${date(Math.min(...test.map((t) => t.changed)))}`);
    print(`  Newest: ${date(Math.max(...test.map((t) => t.changed)))}`);
  }
  print(`Test folders changed after that time, left alone: ${count(late)}`);
  const rows = [...others];
  for (const [key, g] of groups) {
    const dates = date(g.first) === date(g.last) ? date(g.first) : `${date(g.first)} to ${date(g.last)}`;
    rows.push({ key, text: `${plural(g.n, "folder")}, ${dates}` });
  }
  if (rows.length > 0) {
    rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const width = Math.max(...rows.map((r) => r.key.length)) + 4;
    print("");
    print("Not sure (never deleted):");
    for (const r of rows) print(`  ${r.key.padEnd(width)}${r.text}`);
  }
  print("");
  if (test.length === 0 || (await ask("Delete these folders? (y/n) ")).trim() !== "y") return print("Nothing was deleted.");

  let removed = 0;
  const left = [];
  for (const t of test) {
    const got = await tryRemoveTree(path.join(temp, t.name), { pause: 0, limit: 0, listedAsFolder: true });
    if (got.length === 0) removed++;
    else left.push(...got);
  }
  print(`Removed ${plural(removed, "test folder")}.`);
  if (left.length > 0) {
    print(`Left ${count(left.length)}:`);
    for (const l of left) print(`  ${path.relative(temp, l.path)}: ${l.reason}`);
  }
  print(`Not sure, not touched: ${count(others.length + [...groups.values()].reduce((n, g) => n + g.n, 0))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await clearOldTestLeftovers({ temp: tmpdir(), ask: (question) => rl.question(question), print: (line) => console.log(line) });
  } finally {
    rl.close();
  }
}
