// A second Tachikoma process for tests/memory/oslock.test.ts, run as
// `node --import tsx tests/memory/oslock-child.ts <mode> <folder> <name>`.
// - hold: tries the lock once and prints "took" or "busy". Having taken it, it lets go when a "release" line comes in
//   (printing "released") and stays running until its input closes.
// - warnings: acts as Node 22 does, which emits an ExperimentalWarning when node:sqlite is first loaded, and prints
//   "loaded" when that happens, so a load at import time would go unseen. Then it takes and lets go the lock, and
//   emits a warning of its own, which must still be shown. Both are emitted as text and a type, as Node 22 does.
// - warning-objects: the same, with both emitted as a warning object (an Error whose name is the type).
import { createInterface } from "node:readline";
import { tryLock, type LockName } from "../../src/memory/oslock.js";

const [mode, folder, name] = process.argv.slice(2) as [string, string, LockName];

if (mode === "warnings" || mode === "warning-objects") {
  const warn = (text: string) => {
    if (mode === "warnings") return process.emitWarning(text, "ExperimentalWarning");
    const warning = new Error(text);
    warning.name = "ExperimentalWarning";
    process.emitWarning(warning);
  };
  const load = process.getBuiltinModule;
  process.getBuiltinModule = ((id: string) => {
    if (id === "node:sqlite") {
      console.log("loaded");
      warn("SQLite is an experimental feature and might change at any time");
    }
    return load(id);
  }) as typeof process.getBuiltinModule;
  const lock = tryLock(folder, name);
  console.log(lock ? "took" : "busy");
  lock?.release();
  warn("another warning, still shown");
} else {
  const lock = tryLock(folder, name);
  console.log(lock ? "took" : "busy");
  if (lock) {
    createInterface({ input: process.stdin }).on("line", (line) => {
      if (line !== "release") return;
      lock.release();
      console.log("released");
    });
  }
}
