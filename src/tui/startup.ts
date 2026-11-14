import path from "node:path";
import stringWidth from "string-width";
import type { Sandbox } from "../clilib.js";
import { visible } from "../core/permissions.js";
import { asciiRows, pixelRows } from "./art.js";
import type { Line, Span } from "./describe.js";
import { type Colour, type Look, palette } from "./theme.js";
import { cut } from "./view.js";

// The start-up box (TUI design pass, Task 6; design, "2. Start-up box"): the drawing beside what loaded, in a rounded
// border with the version on top, then the hint. Laid out once, for the width it is given (cli.tsx gives textWidth's),
// and never again: each row is one line, which a narrower screen cuts with "…" (design, "Resizing").

// What the box lists, from what cli.tsx already has at launch. `folder` and `files`, the instruction files read, have the
// user's folder as ~ (clilib.ts, tilde); `servers` are the MCP servers starting; `hooks` the hooks in force.
export interface StartInfo {
  version: string;
  lead: string;
  folder: string;
  branch: string | null;
  mode: string;
  sandbox: Sandbox;
  files: string[];
  servers: number;
  hooks: number;
}

// The design's picture's spacing, chosen by the user on 2026-11-13 ("Gap 2, right pad 2"): 2 columns inside each border,
// 2 between the drawing and the list, and 2 after the longest label, as "folder  " has in the picture.
const PAD = 2;
const GAP = 2;
const LABEL_GAP = 2;
const BORDERS = 2;
// Under the box, indented 2 as in the picture ("Lines this plan adds").
const HINT = "  ? for shortcuts · / for commands";

interface Item {
  label: string;
  value: string;
  least?: string; // the row at its shortest, as the drawing is picked, when not its value
  fit?: (room: number) => string; // the row in `room` columns, when it shortens otherwise than by its end
}

// Each file by its name, or by its path where another file has the same name (the user's choice, 2026-11-13: "Short paths
// when repeated").
function namesOf(files: string[]): string[] {
  const names = files.map((f) => path.basename(f));
  return files.map((f, i) => (names.filter((n) => n === names[i]).length > 1 ? f : names[i]!));
}

// The first `k` names, and "and N more" for the rest.
const some = (names: string[], k: number) => (k >= names.length ? names.join(", ") : `${names.slice(0, k).join(", ")} and ${names.length - k} more`);
// The read row at its shortest: one name and "and N more", or every name where that is shorter (Task 6's code review).
const least = (names: string[]) => [names.join(", "), some(names, 1)].reduce((a, b) => (stringWidth(b) < stringWidth(a) ? b : a));

// The read row in `room` columns: every name, or as many as fit before "and N more" (the user's choice, 2026-11-13, "Cut
// inside the box"); where none fits, its shortest, which the row then cuts.
function named(names: string[], room: number): string {
  for (let k = names.length; k >= 1; k--) if (stringWidth(some(names, k)) <= room) return some(names, k);
  return least(names);
}

// The folder row in `room` columns (the user's choice, 2026-11-13: "Cut the path's middle"): whole; else the path's start,
// "…" for its middle, and the folder's own name and the branch, keeping as much of the start as fits, by the separator
// the path itself has; else, where even its first part, "…" and its name do not fit, the whole cut at its end. `folder`
// is as given, split before its parts are escaped, as an escape has a backslash of its own.
function placed(folder: string, branch: string, room: number): string {
  const whole = visible(folder) + branch;
  if (stringWidth(whole) <= room) return whole;
  const sep = /[\\/]/.exec(folder)?.[0];
  if (sep !== undefined) {
    const parts = folder.split(sep).map((p) => visible(p));
    for (let k = parts.length - 2; k >= 1; k--) {
      const form = `${parts.slice(0, k).join(sep)}${sep}…${sep}${parts.at(-1)}${branch}`;
      if (stringWidth(form) <= room) return form;
    }
  }
  return cut(whole, room);
}

// The box's rows, then the hint. The drawing is the pixel art with full colour, else the ASCII drawing, else none: the
// first whose columns, with the borders, padding, gap and the list at its narrowest (the read row at its shortest, the
// folder cut to "…"), fit `width`. The box is then as wide as the list wants, up to `width`; a value wider than its room is
// cut with "…" inside the border. The border and labels are muted, the values the terminal's own colour (the user's
// choice, 2026-11-13).
// Everything given is escaped before it is measured, as it comes from the disk, git and the settings.
export function startBox(info: StartInfo, width: number, look: Look): Line[] {
  const colours = palette(look);
  const muted = colours.muted;
  const names = namesOf(info.files).map((f) => visible(f));
  const branch = info.branch === null ? "" : `  git:(${visible(info.branch)})`;
  const n = info.servers;
  const items: Item[] = [
    { label: "lead", value: visible(info.lead) },
    // At its shortest the folder is cut to "…" alone, so a long path never costs the drawing (the user's choice,
    // 2026-11-13: "Never costs drawing").
    { label: "folder", value: visible(info.folder) + branch, least: "…", fit: (room) => placed(info.folder, branch, room) },
    { label: "mode", value: `${visible(info.mode)} · sandbox ${info.sandbox}` },
    ...(names.length ? [{ label: "read", value: names.join(", "), least: least(names), fit: (room: number) => named(names, room) }] : []),
    ...(n ? [{ label: "mcp", value: `${n} server${n === 1 ? "" : "s"} starting` }] : []),
    ...(info.hooks ? [{ label: "hooks", value: String(info.hooks) }] : []),
  ];
  const labels = Math.max(...items.map((i) => i.label.length)) + LABEL_GAP;
  const list = (narrowest: boolean) => labels + Math.max(...items.map((i) => stringWidth(narrowest ? (i.least ?? i.value) : i.value)));
  const title = `Tachikoma ${visible(info.version)}`;
  const titled = stringWidth(title) + 6; // "╭─ ", the title, " ─╮"

  const drawings = [...(look.full ? [pixelRows()] : []), asciiRows(), []];
  const columnsOf = (art: Line[]) => Math.max(0, ...art.map((l) => stringWidth(l.text)));
  const outside = (art: Line[]) => BORDERS + PAD + (art.length ? columnsOf(art) + GAP : 0) + PAD;
  const art = drawings.find((d) => !d.length || outside(d) + list(true) <= width)!;
  const drawn = columnsOf(art);
  const around = outside(art);
  // As wide as the list or the title wants, up to `width`, and never wider (Task 6's code review), but for a terminal
  // narrower than the box's least: a border and its padding each side and one column of text, below which there is no
  // box to draw.
  const boxWidth = Math.max(BORDERS + 2 * PAD + 1, Math.min(width, Math.max(around + list(false), titled)));
  const inner = boxWidth - around; // the list's columns
  const room = inner - labels; // a value's columns; none where the box is narrower than its labels
  // The title cut where the box is narrower than it, so the top border is no wider than the rows (Task 6's code review).
  const shownTitle = cut(title, boxWidth - 6);
  const dashes = boxWidth - 5 - stringWidth(shownTitle); // the dashes left after "╭─ ", the title and " ", before "╮"

  // A row built from parts, each muted or coloured as given; a part with no colour has no span.
  const row = (parts: { text: string; color?: Colour | undefined; styles?: Span[] }[]): Line => {
    let text = "";
    const styles: Span[] = [];
    for (const p of parts) {
      if (p.color !== undefined) styles.push({ start: text.length, end: text.length + p.text.length, color: p.color });
      for (const s of p.styles ?? []) styles.push({ ...s, start: s.start + text.length, end: s.end + text.length });
      text += p.text;
    }
    return { text, ...(styles.length ? { styles } : {}), oneLine: true };
  };
  const padTo = (s: string, columns: number) => s + " ".repeat(Math.max(0, columns - stringWidth(s)));

  const lines: Line[] = [
    {
      ...row([{ text: "╭─ ", color: muted }, { text: shownTitle }, { text: ` ${"─".repeat(dashes)}╮`, color: muted }]),
      block: true,
    },
  ];
  for (let r = 0; r < Math.max(art.length, items.length); r++) {
    const parts: Parameters<typeof row>[0] = [{ text: "│", color: muted }, { text: " ".repeat(PAD) }];
    if (art.length) {
      const a = art[r];
      parts.push({ text: padTo(a?.text ?? "", drawn), color: a?.color && colours[a.color], ...(a?.styles ? { styles: a.styles } : {}) }, { text: " ".repeat(GAP) });
    }
    const item = items[r];
    if (item && room >= 1) {
      parts.push({ text: item.label.padEnd(labels), color: muted }, { text: padTo(cut(item.fit?.(room) ?? item.value, room), room) });
    } else if (item) parts.push({ text: padTo(cut(item.label, inner), inner), color: muted }); // no room for a value
    else parts.push({ text: " ".repeat(inner) });
    parts.push({ text: " ".repeat(PAD) }, { text: "│", color: muted });
    lines.push(row(parts));
  }
  lines.push(row([{ text: `╰${"─".repeat(boxWidth - 2)}╯`, color: muted }]));
  lines.push({ text: HINT, color: "muted", oneLine: true });
  return lines;
}
