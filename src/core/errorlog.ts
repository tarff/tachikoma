import { appendFileSync } from "node:fs";
import path from "node:path";
import { privateDir, readPrivate } from "../auth/private.js";
import type { Bus, ErrorEvent } from "./bus.js";
import { errorText } from "./types.js";

type Row = ErrorEvent & { at: string; session: string };

// One JSON line per failure, in a private folder in Tachikoma's data folder (review fixes plan, fix 3): the log holds
// failed inputs (whole files, full commands) that may contain secrets, and nothing in a project can lead it elsewhere.
// A file made in the private folder has its permissions. One append per row, so two sessions in one project keep each
// other's rows. The log is optional: if it cannot be written, it says so once and turns itself off.
// The first error of a session runs PowerShell to make the folder private, about 0.4 s once (the code review measured
// 385 ms); privateDir remembers the folder after that (review fixes plan, fix 11).
export function attachErrorLog(bus: Bus, file: string, session: string): void {
  const write = (e: ErrorEvent) => {
    try {
      privateDir(path.dirname(file));
      const row: Row = { at: new Date().toISOString(), session, ...e };
      appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
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
// input is the whole file), so the escapes and wide characters count. Read as the prompt history is, so what
// readPrivate says, such as that it made the log private, comes first.
export function summarize(file: string): string[] {
  const said: string[] = [];
  const text = readPrivate(file, (w) => said.push(w));
  if (text === null) return ["No errors logged yet."];
  const lines = text.split("\n").filter(Boolean);
  const rows = lines.map(parse).filter((r) => r !== undefined);
  const skipped = lines.length - rows.length;
  const note = skipped ? [`(${skipped} unreadable line${skipped === 1 ? "" : "s"} skipped)`] : [];
  if (rows.length === 0) return [...said, "No errors logged yet.", ...note];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  const rescued = counts.get("fallback") ?? 0; // logged so /errors shows them, but not failures
  const last = rows.at(-1)!;
  return [
    ...said,
    `${rows.length - rescued} errors${rescued ? ` and ${rescued} refusals another model answered,` : ""} logged in ${file}`,
    ...[...counts].map(([kind, n]) => `  ${kind}: ${n}`),
    `Most recent (${last.at}): ${last.attempted}`,
    `  ${last.message.split("\n")[0]}`,
    ...note,
  ];
}
