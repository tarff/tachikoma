import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Bus, ErrorEvent } from "./bus.js";
import { errorText } from "./types.js";

type Row = ErrorEvent & { at: string; session: string };

// One JSON line per failure, in the project's .tachikoma folder.
// The log is optional: if it cannot be written, it says so once and turns itself off.
export function attachErrorLog(bus: Bus, file: string, session: string): void {
  const write = (e: ErrorEvent) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const row: Row = { at: new Date().toISOString(), session, ...e };
      appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    } catch (err) {
      bus.off("error", write);
      console.error(`Error log turned off: could not write ${file} (${errorText(err)}).`);
    }
  };
  bus.on("error", write);
}

export function summarize(file: string): string {
  if (!existsSync(file)) return "No errors logged yet.";
  const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (rows.length === 0) return "No errors logged yet.";
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const last = rows.at(-1)!;
  return [
    `${rows.length} errors logged in ${file}`,
    ...[...counts].map(([kind, n]) => `  ${kind}: ${n}`),
    `Most recent (${last.at}): ${last.attempted}\n  ${last.message.split("\n")[0]}`,
  ].join("\n");
}
