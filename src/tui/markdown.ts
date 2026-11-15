import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import type { Line, Span } from "./describe.js";
import type { Colour, Palette } from "./theme.js";

// A reply's markdown as styled lines (TUI design pass, Task 15; design, "5. Markdown"): marked's lexer splits the text into
// pieces (choice A) and this draws them. Laid out for `width`, the budget its caller gives (plan, Architecture, "Laid out
// for the width text really has"); only a table and a rule use it, as the screen wraps the rest. Each line is one row of
// the source, a list's or a quote's lead in its text and its `indent`, so a wrapped row starts under the text.

// A list sits two columns in from the text around it, a list in an item under the item's text. A bulleted item's mark
// alternates by the bulleted lists above it, `•` then `◦` (the user's choice, 2026-11-16: "• then ◦ when nested"); a
// numbered list between them keeps its numbers and does not count.
const LIST_IN = "  ";
const BULLETS = ["•", "◦"];
const BAR = "│ ";

// Text with its spans, as built from a run of inline pieces; split into lines at its line breaks.
interface Run {
  text: string;
  styles: Span[];
}

// A span of the given style; one with no style left (a colour the palette has not, without colour) is none.
function styled(start: number, end: number, style: Omit<Span, "start" | "end">): Span[] {
  const kept = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length && end > start ? [{ start, end, ...kept }] : [];
}
const withStyles = (styles: Span[]) => (styles.length ? { styles } : {});

// Inline pieces into `run`. Text goes through visible() as the screen escapes it (describe.ts, screen): prose keeps its
// tabs and line breaks, a table's cell (`oneLine`) has its tabs shown as `⇥`, so it is measured as it is drawn. Each style
// is pushed before what it covers, so a piece's own style draws over it.
function inline(tokens: readonly Token[], palette: Palette, oneLine: boolean, run: Run): void {
  const escape = (s: string) => (oneLine ? visible(s) : s.split("\n").map((p) => visible(p, { tabs: true })).join("\n"));
  const add = (s: string) => {
    run.text += escape(s);
  };
  const over = (style: Omit<Span, "start" | "end">, draw: () => void) => {
    const start = run.text.length;
    const at = run.styles.length;
    draw();
    run.styles.splice(at, 0, ...styled(start, run.text.length, style));
  };
  for (const t of tokens) {
    const k = t as Token & { tokens?: Token[]; text?: string };
    if (t.type === "text") {
      if (k.tokens) inline(k.tokens, palette, oneLine, run);
      else add(k.text ?? t.raw);
    } else if (t.type === "escape") add(k.text ?? t.raw);
    else if (t.type === "strong") over({ bold: true }, () => inline(k.tokens ?? [], palette, oneLine, run));
    else if (t.type === "em") over({ italic: true }, () => inline(k.tokens ?? [], palette, oneLine, run));
    else if (t.type === "codespan") over({ color: palette.accent }, () => add(k.text ?? ""));
    else if (t.type === "del") over({ strike: true }, () => inline(k.tokens ?? [], palette, oneLine, run)); // "Struck through"
    else if (t.type === "br") add("\n");
    else if (t.type === "link") {
      const link = t as Tokens.Link;
      const start = run.text.length;
      over({ underline: true }, () => inline(link.tokens, palette, oneLine, run));
      // An autolink's text is its address as written, though marked adds "mailto:" or "http://" to its href. Another
      // address goes after the text in brackets, both muted (the user's choice, 2026-11-16: "In brackets").
      // No space where the link drew no text, and no brackets with no address (Task 15's code review).
      if (!link.autolink && link.href !== "" && run.text.slice(start) !== escape(link.href)) {
        if (run.text.length > start) add(" ");
        over({ color: palette.muted }, () => add(`(${link.href})`));
      }
    } else add(t.raw); // raw HTML, a picture, a task's box and anything else, as written
  }
}

const runOf = (tokens: readonly Token[], palette: Palette, oneLine = false): Run => {
  const run: Run = { text: "", styles: [] };
  inline(tokens, palette, oneLine, run);
  return run;
};

// A run as one line for each of its line breaks, each with the part of each span over it. Each span goes only to the rows
// it reaches, the first found by a binary search, and in the spans' order, so a later still draws over an earlier: time
// that grows with the rows and spans, not their product (Task 15's code review).
function rows(run: Run): Line[] {
  const texts = run.text.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const t of texts) {
    starts.push(at);
    at += t.length + 1; // 1: the line break
  }
  const pieces: Span[][] = texts.map(() => []);
  for (const { start, end, ...style } of run.styles) {
    let lo = 0; // the last row starting at or before the span
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= start) lo = mid;
      else hi = mid - 1;
    }
    for (let r = lo; r < texts.length && starts[r]! < end; r++) {
      const from = starts[r]!;
      pieces[r]!.push(...styled(Math.max(start, from) - from, Math.min(end, from + texts[r]!.length) - from, style));
    }
  }
  return texts.map((text, r) => ({ text, ...withStyles(pieces[r]!) }));
}

// A source's text as written, a line for each of its lines: what is not drawn otherwise.
const rawLines = (raw: string): Line[] =>
  raw
    .replace(/\n+$/, "")
    .split("\n")
    .map((text) => ({ text: visible(text, { tabs: true }) }));

// The line with `lead` before its text, in `color` where given; a wrapped row starts after it. An empty line takes the
// lead without its trailing spaces, so a copy has none.
function led(l: Line, lead: string, color?: Colour): Line {
  const shown = l.text === "" ? lead.trimEnd() : lead;
  const styles = [...styled(0, shown.length, { color }), ...(l.styles ?? []).map((s) => ({ ...s, start: s.start + shown.length, end: s.end + shown.length }))];
  return {
    ...l,
    text: shown + l.text,
    ...withStyles(styles),
    ...(l.oneLine || l.text === "" ? {} : { indent: shown.length + (l.indent ?? 0) }),
  };
}

// Whether the source has a blank line after an item: its raw text ends in two line breaks or more.
const blankAfter = (item: Tokens.ListItem) => (item.raw.slice(item.raw.trimEnd().length).match(/\n/g)?.length ?? 0) >= 2;

function list(l: Tokens.List, width: number, palette: Palette, inItem: boolean, bullets: number): Line[] {
  const pad = inItem ? "" : LIST_IN;
  const first = l.start === "" ? 1 : l.start;
  const within = l.ordered ? bullets : bullets + 1; // the bulleted lists its items' own lists are under
  return l.items.flatMap((item, i) => {
    const mark = `${pad}${l.ordered ? `${first + i}.` : BULLETS[bullets % BULLETS.length]} `;
    // A tight task item's box comes as a piece of its own before its text: drawn on the text's line, as written.
    const [head, next, ...rest] = item.tokens;
    const tokens: Token[] =
      head?.type === "checkbox" && next?.type === "text" ? [{ type: "text", raw: "", text: "", tokens: [head, ...((next as Tokens.Text).tokens ?? [next])] }, ...rest] : item.tokens;
    const inner = blocks(tokens, width - mark.length, palette, true, within);
    const lines = (inner.length ? inner : [{ text: "" }]).map((line, k) => led(line, k === 0 ? mark : " ".repeat(mark.length)));
    return blankAfter(item) && i < l.items.length - 1 ? [...lines, { text: "" }] : lines;
  });
}

// A table with box lines, rounded as the start-up box's and the question's (startup.ts; Task 9), muted as theirs, a column
// as wide as its widest cell and a space each side; every row one line, as the screen cuts it rather than wrap it (design,
// "Resizing"). Null where it is wider than `width`, so it is left as its raw text.
function table(t: Tokens.Table, width: number, palette: Palette): Line[] | null {
  const cells = [t.header, ...t.rows].map((row) => row.map((c) => runOf(c.tokens, palette, true)));
  const widths = t.header.map((_, i) => Math.max(...cells.map((row) => stringWidth(row[i]?.text ?? ""))));
  const total = widths.reduce((a, w) => a + w + 3, 1); // a border before each column, a space each side, the last border
  if (total > width) return null;
  const muted = palette.muted;
  const border = (l: string, m: string, r: string): Line => {
    const text = `${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}`;
    return { text, ...withStyles(styled(0, text.length, { color: muted })), oneLine: true };
  };
  const row = (runs: Run[]): Line => {
    let text = "";
    const styles: Span[] = [];
    const bar = () => {
      styles.push(...styled(text.length, text.length + 1, { color: muted }));
      text += "│";
    };
    widths.forEach((w, i) => {
      const run = runs[i] ?? { text: "", styles: [] };
      const gap = w - stringWidth(run.text);
      const align = t.align[i];
      const left = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
      bar();
      text += ` ${" ".repeat(left)}`;
      styles.push(...run.styles.map((s) => ({ ...s, start: s.start + text.length, end: s.end + text.length })));
      text += `${run.text}${" ".repeat(gap - left)} `;
    });
    bar();
    return { text, ...withStyles(styles), oneLine: true };
  };
  const [header, ...body] = cells;
  return [border("╭", "┬", "╮"), row(header!), ...(body.length ? [border("├", "┼", "┤"), ...body.map(row)] : []), border("╰", "┴", "╯")];
}

// Block pieces as lines, laid out for `width`. A blank line in the source (marked's `space`) is one empty line; pieces
// with none between them touch, as written. `inItem`: the pieces are a list item's own, so a list among them is under the
// item's text and not two columns further in. `bullets`: how many bulleted lists the pieces are under, a quote's included.
function blocks(tokens: readonly Token[], width: number, palette: Palette, inItem = false, bullets = 0): Line[] {
  const out: Line[] = [];
  for (const t of tokens) {
    // A link's definition draws nothing (the user's choice, 2026-11-16: "Hide them"), so the blank lines either side of it
    // are one empty line, as a single blank line is.
    if (t.type === "def") continue;
    if (t.type === "space") {
      if (out.at(-1)?.text !== "" || out.at(-1)?.band) out.push({ text: "" });
    } else if (t.type === "paragraph" || t.type === "text") {
      const k = t as Tokens.Paragraph | Tokens.Text;
      out.push(...rows(runOf(k.tokens ?? [{ type: "text", raw: k.raw, text: k.text }], palette)));
    } else if (t.type === "heading") {
      const run = runOf((t as Tokens.Heading).tokens, palette);
      run.styles.unshift(...styled(0, run.text.length, { bold: true, color: palette.accent }));
      out.push(...rows(run));
    } else if (t.type === "code") {
      // On the band, in the text's own colour, no highlighting (choice B); the fences and language are not part of its text.
      out.push(...(t as Tokens.Code).text.split("\n").map((text) => ({ text: visible(text, { tabs: true }), band: true as const })));
    } else if (t.type === "hr") {
      const text = "─".repeat(Math.max(1, width));
      out.push({ text, ...withStyles(styled(0, text.length, { color: palette.muted })), oneLine: true });
    } else if (t.type === "blockquote") {
      out.push(...blocks((t as Tokens.Blockquote).tokens, width - BAR.length, palette, false, bullets).map((l) => led(l, BAR, palette.muted)));
    } else if (t.type === "list") out.push(...list(t as Tokens.List, width, palette, inItem, bullets));
    else if (t.type === "table") out.push(...(table(t as Tokens.Table, width, palette) ?? rawLines(t.raw)));
    else out.push(...rawLines(t.raw)); // raw HTML and anything else, as written
  }
  // No empty line at either end: the gap before and after a block is the conversation's (describe.ts, gapped).
  while (out[0]?.text === "" && !out[0].band) out.shift();
  while (out.at(-1)?.text === "" && !out.at(-1)!.band) out.pop();
  return out;
}

// The lines `text` is drawn as, in `palette`'s colours, laid out for `width` columns.
// Text nested too deep for marked's lexer, which recurses into each level, or for blocks(), which walks the same tree,
// overflows the stack ("*" or "- " or ">" thousands deep): it is drawn as its raw text, its line breaks read as marked
// reads them (Task 15's code review). Its blank lines are as the markdown path draws them: none at either end, a run of
// them one empty line (the re-check); a raw table's or raw HTML's keep their own, as written.
export function markdownLines(text: string, width: number, palette: Palette): Line[] {
  try {
    return blocks(marked.lexer(text), width, palette);
  } catch {
    const out: Line[] = [];
    for (const l of rawLines(text.replace(/\r\n?/g, "\n"))) {
      if (l.text.trim() !== "") out.push(l);
      else if (out.length && out.at(-1)!.text !== "") out.push({ text: "" });
    }
    if (out.at(-1)?.text === "") out.pop();
    return out;
  }
}
