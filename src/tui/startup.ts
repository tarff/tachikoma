import stringWidth from "string-width";
import type { Sandbox } from "../clilib.js";
import { visible } from "../core/permissions.js";
import { asciiRows, pixelRows } from "./art.js";
import type { Line, Span } from "./describe.js";
import { type Look, palette } from "./theme.js";
import { cut } from "./view.js";

// The start-up box (TUI design pass, Task 6; design, "2. Start-up box"): the drawing beside what loaded, in a rounded
// border with the version on top, then the hint. Laid out once, for the width it is given (cli.tsx gives textWidth's),
// and never again: each row is one line, which a narrower screen cuts with "…" (design, "Resizing").

// What the box lists, from what cli.tsx already has at launch. `folder` has the user's folder as ~ (clilib.ts, tilde);
// `files` are the instruction files' names; `servers` the MCP servers starting; `hooks` the hooks in force.
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
  files?: string[]; // the read row's names, which it cuts with "and N more"
  least?: string; // the row at its shortest, as the drawing is picked, when not its value
}

// The first `k` names, and "and N more" for the rest.
const some = (files: string[], k: number) => (k >= files.length ? files.join(", ") : `${files.slice(0, k).join(", ")} and ${files.length - k} more`);

// The read row in `room` columns: every name, or as many as fit before "and N more", one at least (the user's choice,
// 2026-11-13, "Cut inside the box").
function named(files: string[], room: number): string {
  for (let k = files.length; k > 1; k--) if (stringWidth(some(files, k)) <= room) return some(files, k);
  return some(files, 1);
}

// The box's rows, then the hint. The drawing is the pixel art with full colour, else the ASCII drawing, else none: the
// first whose columns, with the borders, padding, gap and the list at its narrowest (the read row cut to one name, the
// folder to "…"), fit
// `width`. The box is then as wide as the list wants, up to `width`; a value wider than its room is cut with "…" inside
// the border. The border and labels are muted, the values the terminal's own colour (the user's choice, 2026-11-13).
// Everything given is escaped before it is measured, as it comes from the disk, git and the settings.
export function startBox(info: StartInfo, width: number, look: Look): Line[] {
  const colours = palette(look);
  const muted = colours.muted;
  const files = info.files.map((f) => visible(f));
  const n = info.servers;
  const items: Item[] = [
    { label: "lead", value: visible(info.lead) },
    // At its shortest the folder is cut to "…" alone, so a long path never costs the drawing (the user's choice,
    // 2026-11-13: "Never costs drawing").
    { label: "folder", value: visible(info.branch === null ? info.folder : `${info.folder}  git:(${info.branch})`), least: "…" },
    { label: "mode", value: `${visible(info.mode)} · sandbox ${info.sandbox}` },
    ...(files.length ? [{ label: "read", value: files.join(", "), files, least: some(files, 1) }] : []),
    ...(n ? [{ label: "mcp", value: `${n} server${n === 1 ? "" : "s"} starting` }] : []),
    ...(info.hooks ? [{ label: "hooks", value: String(info.hooks) }] : []),
  ];
  const labels = Math.max(...items.map((i) => i.label.length)) + LABEL_GAP;
  const list = (narrowest: boolean) => labels + Math.max(...items.map((i) => stringWidth(narrowest ? (i.least ?? i.value) : i.value)));
  const title = `Tachikoma ${visible(info.version)}`;
  const titled = stringWidth(title) + 6; // "╭─ ", the title, " ─╮"

  const drawings = [...(look.full ? [pixelRows()] : []), asciiRows(colours), []];
  const columnsOf = (art: Line[]) => Math.max(0, ...art.map((l) => stringWidth(l.text)));
  const outside = (art: Line[]) => BORDERS + PAD + (art.length ? columnsOf(art) + GAP : 0) + PAD;
  const art = drawings.find((d) => !d.length || outside(d) + list(true) <= width)!;
  const drawn = columnsOf(art);
  const around = outside(art);
  const boxWidth = Math.max(Math.min(width, Math.max(around + list(false), titled)), around + labels + 1);
  const room = boxWidth - around - labels; // a value's columns

  // A row built from parts, each muted or coloured as given; a part with no colour has no span.
  const row = (parts: { text: string; color?: string | undefined; styles?: Span[] }[]): Line => {
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
      ...row([{ text: "╭─ ", color: muted }, { text: title }, { text: ` ${"─".repeat(Math.max(0, boxWidth - titled + 1))}╮`, color: muted }]),
      block: true,
    },
  ];
  for (let r = 0; r < Math.max(art.length, items.length); r++) {
    const parts: Parameters<typeof row>[0] = [{ text: "│", color: muted }, { text: " ".repeat(PAD) }];
    if (art.length) {
      const a = art[r];
      parts.push({ text: padTo(a?.text ?? "", drawn), color: a?.color, ...(a?.styles ? { styles: a.styles } : {}) }, { text: " ".repeat(GAP) });
    }
    const item = items[r];
    if (item) {
      parts.push({ text: item.label.padEnd(labels), color: muted }, { text: padTo(cut(item.files ? named(item.files, room) : item.value, room), room) });
    } else parts.push({ text: " ".repeat(labels + room) });
    parts.push({ text: " ".repeat(PAD) }, { text: "│", color: muted });
    lines.push(row(parts));
  }
  lines.push(row([{ text: `╰${"─".repeat(boxWidth - 2)}╯`, color: muted }]));
  lines.push({ text: HINT, ...(muted === undefined ? {} : { color: muted }), oneLine: true });
  return lines;
}
