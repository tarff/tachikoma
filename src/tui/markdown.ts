import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { visible } from "../core/permissions.js";
import type { Line, Span } from "./describe.js";
import type { Colour, Palette } from "./theme.js";

// A reply's markdown as styled lines (TUI design pass, Task 15; design, "5. Markdown"): marked's lexer splits the text into
// pieces (choice A) and this draws them. Laid out for `width`, the budget its caller gives (plan, Architecture, "Laid out
// for the width text really has"); only a table and a rule use it, as the screen wraps the rest. Each line is one row of
// the source, a list's or a quote's lead in its text and its `indent`, so a wrapped row starts under the text.

// A list sits two columns in from the text around it, a list in an item under the item's text; `-` before each bulleted
// item, the markdown's own mark, as neither the plan nor the design names one.
const LIST_IN = "  ";
const BULLET = "-";
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
    else if (t.type === "br") add("\n");
    else if (t.type === "link") {
      const link = t as Tokens.Link;
      const start = run.text.length;
      over({ underline: true }, () => inline(link.tokens, palette, oneLine, run));
      // An autolink's text is its address as written, though marked adds "mailto:" or "http://" to its href.
      if (!link.autolink && run.text.slice(start) !== escape(link.href)) {
        add(" ");
        over({ color: palette.muted }, () => add(link.href));
      }
    } else add(t.raw); // raw HTML, a picture, a strikethrough, a task's box and anything else, as written
  }
}

const runOf = (tokens: readonly Token[], palette: Palette, oneLine = false): Run => {
  const run: Run = { text: "", styles: [] };
  inline(tokens, palette, oneLine, run);
  return run;
};

// A run as one line for each of its line breaks, each with the part of each span over it.
function rows(run: Run): Line[] {
  let from = 0;
  return run.text.split("\n").map((text) => {
    const to = from + text.length;
    const styles = run.styles.flatMap((s) => {
      const { start, end, ...style } = s;
      return styled(Math.max(start, from) - from, Math.min(end, to) - from, style);
    });
    from = to + 1; // 1: the line break
    return { text, ...(styles.length ? { styles } : {}) };
  });
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
    ...(styles.length ? { styles } : {}),
    ...(l.oneLine || l.text === "" ? {} : { indent: shown.length + (l.indent ?? 0) }),
  };
}

// Whether the source has a blank line after an item: its raw text ends in two line breaks or more.
const blankAfter = (item: Tokens.ListItem) => (item.raw.slice(item.raw.trimEnd().length).match(/\n/g)?.length ?? 0) >= 2;

function list(l: Tokens.List, width: number, palette: Palette, inItem: boolean): Line[] {
  const pad = inItem ? "" : LIST_IN;
  const first = l.start === "" ? 1 : l.start;
  return l.items.flatMap((item, i) => {
    const mark = `${pad}${l.ordered ? `${first + i}.` : BULLET} `;
    // A tight task item's box comes as a piece of its own before its text: drawn on the text's line, as written.
    const [head, next, ...rest] = item.tokens;
    const tokens: Token[] =
      head?.type === "checkbox" && next?.type === "text" ? [{ type: "text", raw: "", text: "", tokens: [head, ...((next as Tokens.Text).tokens ?? [next])] }, ...rest] : item.tokens;
    const inner = blocks(tokens, width - mark.length, palette, true);
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
// item's text and not two columns further in.
function blocks(tokens: readonly Token[], width: number, palette: Palette, inItem = false): Line[] {
  const out: Line[] = [];
  for (const t of tokens) {
    if (t.type === "space") out.push({ text: "" });
    else if (t.type === "paragraph" || t.type === "text") {
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
      out.push(...blocks((t as Tokens.Blockquote).tokens, width - BAR.length, palette).map((l) => led(l, BAR, palette.muted)));
    } else if (t.type === "list") out.push(...list(t as Tokens.List, width, palette, inItem));
    else if (t.type === "table") out.push(...(table(t as Tokens.Table, width, palette) ?? rawLines(t.raw)));
    else out.push(...rawLines(t.raw)); // raw HTML, a link's definition and anything else, as written
  }
  // No empty line at either end: the gap before and after a block is the conversation's (describe.ts, gapped).
  while (out[0]?.text === "" && !out[0].band) out.shift();
  while (out.at(-1)?.text === "" && !out.at(-1)!.band) out.pop();
  return out;
}

// The lines `text` is drawn as, in `palette`'s colours, laid out for `width` columns.
export function markdownLines(text: string, width: number, palette: Palette): Line[] {
  return blocks(marked.lexer(text), width, palette);
}
