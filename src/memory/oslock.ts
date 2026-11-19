import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// The operating-system lock (8d plan, step 17): the join, install and save locks. The kind is the user's choice at step
// 2 (Q2): an exclusive SQLite transaction on one lock file per lock, which the system lets go when its holder dies, on
// Windows, Linux and macOS. Two operations only: try to take it, and let go. A caller that is refused waits and tries
// again (500 ms, the user's choice at step 8). A refused try holds the thread for about 31 ms on Windows (step 8).
//
// The lock file is `<folder>/<name>.lock`, in a folder of Tachikoma's own; nothing in the process opens it except
// SQLite, as a close() of it elsewhere would cancel the lock on Linux and macOS (step 2's record, note 8). A file left
// by a holder that was killed holds no lock, and the next process takes it.

export type LockName = "join" | "install" | "save";

export interface OsLock {
  release(): void;
}

// Kept here while held: a database nothing refers to is closed when it is collected, and that lets the lock go (step
// 2's record, note 7).
const held = new Set<DatabaseSync>();

let sqlite: typeof import("node:sqlite") | undefined;

// Loaded at the first take, never at launch. Node 22 prints an ExperimentalWarning when node:sqlite is first loaded;
// the user's choice after step 17 is to drop only that one warning, for the length of the load, and show every other.
function load(): typeof import("node:sqlite") {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  // Emitted as text with a type (or options holding one), or as a warning object whose name is its type.
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const given = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const type = typeof warning === "string" ? given : warning.name;
    const text = typeof warning === "string" ? warning : warning.message;
    if (type === "ExperimentalWarning" && text.startsWith("SQLite is an experimental feature")) return;
    Reflect.apply(emit, process, [warning, ...rest]);
  }) as typeof process.emitWarning;
  try {
    sqlite = process.getBuiltinModule("node:sqlite");
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

// Takes the lock, or returns null when another holds it, in this process or another. The folder is the caller's to
// make; it is not made here.
export function tryLock(folder: string, name: LockName): OsLock | null {
  const { DatabaseSync: Database } = load();
  let db: DatabaseSync;
  try {
    db = new Database(path.join(folder, `${name}.lock`), { timeout: 0 });
  } catch (err) {
    if (!existsSync(folder)) throw new Error(`the ${name} lock's folder is missing: ${folder}`, { cause: err });
    throw err;
  }
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (err) {
    db.close();
    // SQLITE_BUSY, "database is locked". node:sqlite's `errcode` is SQLite's extended code (a unique-constraint
    // failure gives 2067, not 19), so the busy codes' low 8 bits are compared.
    if ((((err as { errcode?: number }).errcode ?? 0) & 0xff) === 5) return null;
    throw err;
  }
  held.add(db);
  return {
    release() {
      if (held.delete(db)) db.close();
    },
  };
}
