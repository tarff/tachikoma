import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Bus, ErrorEvent } from "./bus.js";
import { errorText } from "./types.js";

type Row = ErrorEvent & { at: string; session: string };

// One JSON line per failure, in the project's .tachikoma folder, which it keeps out of git.
// The log is optional: if it cannot be written, it says so once and turns itself off.
export function attachErrorLog(bus: Bus, file: string, session: string): void {
  const write = (e: ErrorEvent) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // The log holds failed inputs (whole files, full commands) that may contain secrets.
      const ignore = path.join(path.dirname(file), ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n", "utf8");
      const row: Row = { at: new Date().toISOString(), session, ...e };
      appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    } catch (err) {
      bus.off("error", write);
      console.error(`Error log turned off: could not write ${file} (${errorText(err)}).`);
    }
  };
  bus.on("error", write);
}

// A killed process or a full disk can leave a half-written line; one bad line must not hide the rest.
function parse(line: string): Row | undefined {
  try {
    const r = JSON.parse(line);
    if (typeof r?.kind === "string" && typeof r.attempted === "string" && typeof r.message === "string") return r;
  } catch {}
  return undefined;
}

// One row per screen line. The screen escapes each row and cuts it to its width (a failed write_file's
// input is the whole file), so the escapes and wide characters count.
export function summarize(file: string): string[] {
  if (!existsSync(file)) return ["No errors logged yet."];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const rows = lines.map(parse).filter((r) => r !== undefined);
  const skipped = lines.length - rows.length;
  const note = skipped ? [`(${skipped} unreadable line${skipped === 1 ? "" : "s"} skipped)`] : [];
  if (rows.length === 0) return ["No errors logged yet.", ...note];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const rescued = counts.get("fallback") ?? 0; // logged so /errors shows them, but not failures
  const last = rows.at(-1)!;
  return [
    `${rows.length - rescued} errors${rescued ? ` and ${rescued} refusals another model answered,` : ""} logged in ${file}`,
    ...[...counts].map(([kind, n]) => `  ${kind}: ${n}`),
    `Most recent (${last.at}): ${last.attempted}`,
    `  ${last.message.split("\n")[0]}`,
    ...note,
  ];
}
