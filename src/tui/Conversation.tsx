import { Box, Text } from "ink";
import { type ReactNode, useContext } from "react";
import type { Line, Span } from "./describe.js";
import { segmenter } from "./editor.js";
import type { Found } from "./find.js";
import { drawn, ordered } from "./select.js";
import { ThemeContext } from "./theme.js";
import { bar, columnsAt, firstRowEnd, inner, type Pos, type Row, type Rows } from "./view.js";

// The conversation in full screen (release 5 design, "The screen", "Scrolling"): `height` rows from `first`, each in its
// line's colour, then blank rows, so what is drawn under it stays at the bottom of the screen; a view held past the
// bottom (view.ts, first) draws only the rows there are. The rows are wrapped one column short (release 5 plan, choice
// 1), and that column takes the scroll bar once the lines are longer than the view. While the view does not follow, its
// last row counts the lines that came in (choice 5). Each row is a Box one row tall, as an empty Text takes no row. The
// selection shows in reverse colours on the text only, never on the bar's column (release 5 design, "Selecting"), and so
// do the detail view's search matches, `found` (DetailView.tsx; plan, choice 12). `bottom` is the key bound to
// scroll:bottom, which the count names (release 6 plan, Task 6), if any. A band row is on the band colour to the bar's
// column (TUI design pass, Task 2).
export function Conversation({
  rows,
  first,
  height,
  unseen,
  following,
  selection = null,
  found = [],
  bottom,
}: {
  rows: Rows;
  first: number;
  height: number;
  unseen: number;
  following: boolean;
  selection?: [Pos, Pos] | null;
  found?: readonly Found[];
  bottom?: string;
}) {
  const { palette } = useContext(ThemeContext);
  const thumb = bar(rows.total, height, first);
  const note = !following && unseen > 0 ? `↓ ${unseen} new line${unseen === 1 ? "" : "s"}${bottom === undefined ? "" : ` · ${bottom}`}` : null;
  const marks = found.map((m): [Pos, Pos] => [
    { line: m.line, offset: m.start },
    { line: m.line, offset: m.end },
  ]);
  if (selection) marks.push(selection);
  return Array.from({ length: height }, (_, i) => {
    const row = note && i === height - 1 ? { text: note, color: "muted" as const } : first + i < rows.total ? rows.row(first + i) : null;
    const parts = row && "line" in row ? marked(rows, row, marks) : null;
    const shown = row && (
      <Text color={row.color && palette[row.color]} wrap="truncate-end">
        {parts ?? row.text}
      </Text>
    );
    return (
      <Box key={i} height={1}>
        {row && "line" in row && row.band ? (
          <Band width={rows.width}>{shown}</Band>
        ) : (
          <Box width={rows.width} flexShrink={0}>
            {shown}
          </Box>
        )}
        {thumb && <Text color={palette.muted}>{i >= thumb.start && i < thumb.start + thumb.size ? "┃" : "│"}</Text>}
      </Box>
    );
  });
}

// A row drawn in runs (TUI design pass, Task 2): its indent's spaces as they are, then its characters, each in its spans'
// style and in reverse inside the marks (the selection, the search's matches); or null for a row with no span and no
// mark on any of its text, drawn as its text. Its characters are drawn and found as select.ts's placeAt finds them
// (select.ts, drawn).
function marked(rows: Rows, r: Row, marks: [Pos, Pos][]): ReactNode[] | null {
  const inside = marks.flatMap((m) => {
    const [from, to] = ordered(...m);
    const a = r.line === from.line ? from.offset : r.line > from.line ? 0 : Infinity;
    const b = r.line === to.line ? to.offset : r.line < to.line ? Infinity : -Infinity;
    return a >= Math.min(b, r.end) || b <= r.start ? [] : [{ a, b }];
  });
  if (!inside.length && !r.styles?.some((s) => s.end > r.start && s.start < r.end)) return null; // the line's spans: any on this row
  const chars = [...drawn(rows, r)].map((c) => ({
    offset: c.offset,
    text: c.text,
    // The "…" stands for all it cuts, which a mark reaches into or not.
    inverse: inside.some(({ a, b }) => (c.cut ? b > c.offset : c.offset >= a && c.offset < b)),
  }));
  return [...(r.indent ? [" ".repeat(r.indent)] : []), ...runs(chars, r.styles)];
}

type Style = Omit<Span, "start" | "end">;
const STYLE = ["color", "bg", "bold", "italic", "dim", "underline"] as const;

// Characters in runs of one style and one reverse colouring: a run with neither as its text, a reversed one as a Text in
// reverse, a styled one as a Run. A character's style is the spans' over it, a later span's fields over an earlier one's,
// a field it leaves undefined keeping the earlier one's (Task 2's review). The characters come in order of their offsets,
// so the spans are stepped through in order of their starts, and a style made again only where the spans over a
// character change: a line with a span for each of thousands of lines, a long edit's preview, is drawn in time that grows
// with its length (Task 7's review).
// A character's `spaces`, a tab's in classic mode (Printed), is drawn in its place where its style has a background.
function runs(chars: Iterable<{ offset: number; text: string; inverse: boolean; spaces?: string }>, spans: readonly Span[] = []): ReactNode[] {
  const parts: { text: string; style: Style; inverse: boolean }[] = [];
  const order = spans.map((_, i) => i).sort((a, b) => spans[a]!.start - spans[b]!.start);
  let next = 0; // the first in `order` not yet reached
  let open: number[] = []; // the spans over the character before, in their own order
  let style: Style = {};
  for (const c of chars) {
    const before = open.length;
    while (next < order.length && spans[order[next]!]!.start <= c.offset) open.push(order[next++]!);
    const reached = open.length > before;
    const over = open.filter((i) => spans[i]!.end > c.offset);
    if (reached || over.length < open.length) {
      open = reached ? over.sort((a, b) => a - b) : over;
      style = {};
      for (const i of open) for (const k of STYLE) if (spans[i]![k] !== undefined) Object.assign(style, { [k]: spans[i]![k] });
    }
    const text = c.spaces !== undefined && style.bg !== undefined ? c.spaces : c.text;
    const last = parts.at(-1);
    if (last && last.inverse === c.inverse && STYLE.every((k) => last.style[k] === style[k])) last.text += text;
    else parts.push({ text, style, inverse: c.inverse });
  }
  return parts.map((p, k) =>
    STYLE.some((s) => p.style[s] !== undefined) ? (
      <Run key={k} style={p.style} inverse={p.inverse}>
        {p.text}
      </Run>
    ) : p.inverse ? (
      <Text key={k} inverse>
        {p.text}
      </Text>
    ) : (
      p.text
    ),
  );
}

// A styled run, over its line's colour. Without colour (theme.ts, Look) its colour and background are dropped, and bold,
// italic, dim and underline kept (Task 2). `inverse`: the selection's or a search match's reverse, over the style.
function Run({ style, inverse, children }: { style: Style; inverse: boolean; children: string }) {
  const { look } = useContext(ThemeContext);
  return (
    <Text
      color={look.color ? style.color : undefined}
      backgroundColor={look.color ? style.bg : undefined}
      bold={style.bold}
      italic={style.italic}
      dimColor={style.dim}
      underline={style.underline}
      inverse={inverse}
    >
      {children}
    </Text>
  );
}

// A band row's box (Task 2): `width` columns on the band colour, its text, indent and the rest of the row alike; drawn
// plain without colour or without a band colour (theme.ts, palette: none below full colour).
function Band({ width, children }: { width: number; children: ReactNode }) {
  const { look, palette } = useContext(ThemeContext);
  return (
    <Box width={width} flexShrink={0} backgroundColor={look.color ? palette.band : undefined}>
      {children}
    </Box>
  );
}

// A line as classic mode prints it, `columns` the screen's width (Task 2): in runs of its spans' styles; an indented one
// in a row box, its lead (the first `indent` characters) in a box of its own and the rest in a box beside it that
// wraps, so its later rows, wrapped or after a line break, start under the rest (choice P3), as view.ts wraps it in full
// screen; a band line on the band colour the screen's width. A line with none of these prints as it did before, but an
// empty one is a space, as an empty Text takes no row and a gap or a band line must take one (Task 2's review).
export function Printed({ line, columns }: { line: Line; columns: number }) {
  const { look, palette } = useContext(ThemeContext);
  const l = line.text ? line : { ...line, text: " " };
  const n = l.oneLine ? 0 : (l.indent ?? 0);
  // Each character of text[from, to), laid out in a box `width` columns wide when given (the screen's, or the indented
  // text's after its lead). The terminal skips a raw tab's cells without painting a background, so a tab on a line's first
  // row carries the spaces to its stop that full screen draws for it (view.ts, columnsAt), its columns counted from the
  // box's start after `from` or a line break, and runs() draws them where a background is (Task 7's review; the user's
  // choice, 2026-11-13, "Expand first-row tabs"). The first row ends where Ink breaks it (view.ts, firstRowEnd); a tab
  // after that stays a tab, as where it falls is not known here, and Ink's wrapping turns it into spaces itself, painted,
  // counted from its line's start (wrap-ansi 10.0.2, expandTabs). Only with colour: without it nothing is painted.
  const chars = (from: number, to: number, width?: number) => {
    const tabs = width !== undefined && look.color && l.text.slice(from, to).includes("\t");
    const out: { offset: number; text: string; inverse: boolean; spaces?: string }[] = [];
    let col = 0;
    let end = to; // where the first row of the line the character is on ends
    for (const { segment, index } of segmenter.segment(l.text.slice(from, to))) {
      const at = from + index;
      if (!tabs) {
        out.push({ offset: at, text: segment, inverse: false });
        continue;
      }
      if (at === from || l.text[at - 1] === "\n") {
        const next = l.text.indexOf("\n", at);
        end = at + firstRowEnd(l.text.slice(at, next === -1 ? to : Math.min(next, to)), width);
        col = 0;
      }
      const w = columnsAt(segment, col, width);
      out.push({ offset: at, text: segment, inverse: false, ...(segment === "\t" && at < end ? { spaces: " ".repeat(w) } : {}) });
      col += w;
    }
    return out;
  };
  const text = (from: number, to: number, width?: number) => (
    <Text color={l.color && palette[l.color]} wrap={l.oneLine ? "truncate-end" : "wrap"}>
      {l.styles ? runs(chars(from, to, width), l.styles) : l.text.slice(from, to)}
    </Text>
  );
  const body = n ? (
    <>
      <Box width={n} flexShrink={0}>
        {text(0, n)}
      </Box>
      <Box width={inner(columns, n)}>{text(n, l.text.length, inner(columns, n))}</Box>
    </>
  ) : (
    text(0, l.text.length, l.oneLine ? undefined : columns)
  );
  if (l.band) return <Band width={columns}>{body}</Band>;
  return n ? <Box width={columns}>{body}</Box> : body;
}
