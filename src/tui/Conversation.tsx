import { Box, Text } from "ink";
import { type ReactNode, useContext } from "react";
import type { Line, Span } from "./describe.js";
import { segmenter } from "./editor.js";
import type { Found } from "./find.js";
import { drawn, ordered } from "./select.js";
import { ThemeContext } from "./theme.js";
import { bar, columnsAt, columnsOf, edgeBroken, edgeSpaces, firstRowEnd, inner, type Pos, type Row, type Rows, rowStartsAt } from "./view.js";

// The conversation in full screen (release 5 design, "The screen", "Scrolling"): `height` rows from `first`, each in its
// line's colour, then blank rows, so what is drawn under it stays at the bottom of the screen; a view held past the
// bottom (view.ts, first) draws only the rows there are. The rows are wrapped one column short (release 5 plan, choice
// 1), and that column takes the scroll bar once the lines are longer than the view. While the view does not follow, its
// last row counts the lines that came in (choice 5). Each row is a Box one row tall, as an empty Text takes no row. The
// selection shows in reverse colours on the text only, never on the bar's column (release 5 design, "Selecting"), and so
// do the detail view's search matches, `found` (DetailView.tsx; plan, choice 12). `bottom` is the key bound to
// scroll:bottom, which the count names (release 6 plan, Task 6), if any. A band row is on the band colour from its
// line's `bandFrom` column, its start where none, to the bar's column (TUI design pass, Task 2; Task 16).
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
    // A band from a column (Task 16's spec review, "Band from the text"): the columns before it plain, in a box of
    // their own, the rest of the row on the band.
    const bandAt = row && "line" in row && row.band ? Math.min(row.bandFrom ?? 0, rows.width) : 0;
    const parts = row && "line" in row ? marked(rows, row, marks, bandAt) : null;
    const text = (nodes: ReactNode) => row && (
      <Text color={row.color && palette[row.color]} wrap="truncate-end">
        {nodes}
      </Text>
    );
    const shown = text(parts ? [...parts[0], ...parts[1]] : row?.text);
    return (
      <Box key={i} height={1}>
        {row && "line" in row && row.band && bandAt ? (
          <Box width={rows.width} flexShrink={0}>
            <Box width={bandAt} flexShrink={0}>
              {text(parts![0])}
            </Box>
            <Band width={rows.width - bandAt}>{text(parts![1])}</Band>
          </Box>
        ) : row && "line" in row && row.band ? (
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
// (select.ts, drawn). In two parts: what is drawn before column `bandAt` and what is drawn from it, a band from a
// column drawn in a box of each (Task 16's spec review), so a row with one is never null; with none the first part is
// empty.
function marked(rows: Rows, r: Row, marks: [Pos, Pos][], bandAt = 0): [ReactNode[], ReactNode[]] | null {
  const inside = marks.flatMap((m) => {
    const [from, to] = ordered(...m);
    const a = r.line === from.line ? from.offset : r.line > from.line ? 0 : Infinity;
    const b = r.line === to.line ? to.offset : r.line < to.line ? Infinity : -Infinity;
    return a >= Math.min(b, r.end) || b <= r.start ? [] : [{ a, b }];
  });
  if (!bandAt && !inside.length && !r.styles?.some((s) => s.end > r.start && s.start < r.end)) return null; // the line's spans: any on this row
  const chars = [...drawn(rows, r)].map((c) => ({
    offset: c.offset,
    col: c.col,
    text: c.text,
    // The "…" stands for all it cuts, which a mark reaches into or not.
    inverse: inside.some(({ a, b }) => (c.cut ? b > c.offset : c.offset >= a && c.offset < b)),
  }));
  const spaces = r.indent ?? 0;
  const before = Math.min(spaces, bandAt); // the indent's spaces before the column
  return [
    [...(before ? [" ".repeat(before)] : []), ...runs(chars.filter((c) => c.col < bandAt), r.styles)],
    [...(spaces > before ? [" ".repeat(spaces - before)] : []), ...runs(chars.filter((c) => c.col >= bandAt), r.styles)],
  ];
}

type Style = Omit<Span, "start" | "end">;
const STYLE = ["color", "bg", "bold", "italic", "dim", "underline", "strike"] as const;

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
// italic, dim, underline and strikethrough kept (Task 2; Task 15). `inverse`: the selection's or a search match's reverse,
// over the style.
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
      strikethrough={style.strike}
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
// screen; a band line on the band colour from its `bandFrom` column to the screen's width. A line with none of these
// prints as it did before, but an empty one is a space, as an empty Text takes no row and a gap or a band line must
// take one (Task 2's review).
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
  // counted from its line's start (wrap-ansi 10.0.2, expandTabs). Only with colour, as without it nothing is painted;
  // but a band line's are its spaces always, styled or not, with colour or without: Ink counts a raw tab as no column,
  // so it pads the band's row past the screen's edge, and a band from a column must start its tabs' stops there, as
  // full screen does (Task 16's code review). The text keeps its tabs, so a copy has them.
  const bandTabs = (from: number, to: number, width?: number) => width !== undefined && l.band === true && l.text.slice(from, to).includes("\t");
  // A space that ends a row unseen at the box's edge (view.ts, edgeSpaces) is handed to Ink as a line break, so the
  // next row starts under the text, as full screen draws it, where wrap-ansi with trim: false would start it with the
  // space (Task 17's captures, the user's choice, 2026-11-16: "Fix it"). The text keeps the space, so a copy has it.
  const edges = (from: number, to: number, width?: number): ReadonlySet<number> =>
    new Set(width === undefined || l.oneLine ? [] : edgeSpaces(l.text.slice(from, to), width).map((e) => e + from));
  // A band line with tabs is broken into rows here, where full screen breaks it (view.ts, rowStartsAt), each later row
  // after a line break handed to Ink (none after a space already handed as one), and every tab is its spaces counted
  // from its own row's start: Ink, wrapping the spaces itself, broke a later row's tab otherwise, and a raw tab ran the
  // row past the edge it measured (PR 21's review). `rowAt`: where each later row starts.
  const rowsAt = (from: number, to: number, width: number): ReadonlySet<number> => {
    const out = new Set<number>();
    let at = from;
    for (const line of l.text.slice(from, to).split("\n")) {
      for (const s of rowStartsAt(line, width).slice(1)) out.add(at + s);
      at += line.length + 1;
    }
    return out;
  };
  const chars = (from: number, to: number, width?: number) => {
    const tabs = width !== undefined && (look.color || l.band === true) && l.text.slice(from, to).includes("\t");
    const breaks = edges(from, to, width);
    const rowAt = tabs && l.band ? rowsAt(from, to, width!) : null;
    const out: { offset: number; text: string; inverse: boolean; spaces?: string }[] = [];
    let col = 0;
    let end = to; // where the first row of the line the character is on ends
    for (const { segment, index } of segmenter.segment(l.text.slice(from, to))) {
      const at = from + index;
      if (breaks.has(at)) {
        out.push({ offset: at, text: "\n", inverse: false });
        continue;
      }
      if (!tabs) {
        out.push({ offset: at, text: segment, inverse: false });
        continue;
      }
      if (at === from || l.text[at - 1] === "\n") {
        const next = l.text.indexOf("\n", at);
        end = at + firstRowEnd(l.text.slice(at, next === -1 ? to : Math.min(next, to)), width);
        col = 0;
      } else if (rowAt?.has(at)) {
        if (!breaks.has(at - 1)) out.push({ offset: at, text: "\n", inverse: false });
        col = 0;
      }
      const w = columnsAt(segment, col, width);
      const spaces = segment === "\t" && (at < end || rowAt !== null) ? " ".repeat(w) : undefined;
      out.push({ offset: at, text: spaces !== undefined && l.band ? spaces : segment, inverse: false, ...(spaces !== undefined ? { spaces } : {}) });
      col += w;
    }
    return out;
  };
  const text = (from: number, to: number, width?: number) => (
    <Text color={l.color && palette[l.color]} wrap={l.oneLine ? "truncate-end" : "wrap"}>
      {l.styles || bandTabs(from, to, width)
        ? runs(chars(from, to, width), l.styles)
        : width === undefined || l.oneLine
          ? l.text.slice(from, to)
          : edgeBroken(l.text.slice(from, to), width)}
    </Text>
  );
  // A band from a column (Task 16's spec review, "Band from the text"): the characters in the columns before it plain,
  // in a box that wide, and the rest on the band in a box beside it, which wraps, so its later rows start at the
  // column, as full screen's start at the indent the line has there. The split stops before the first character at or
  // past the column, so a tab or a zero-width character there, of no columns of its own, goes on the band (Task 16's
  // code review).
  const bandAt = l.band && l.bandFrom ? Math.min(l.bandFrom, columns) : 0;
  if (bandAt) {
    let k = 0; // the characters before the column
    let col = 0;
    for (const { segment, index } of segmenter.segment(l.text)) {
      if (col >= bandAt) break;
      col += columnsOf(segment);
      k = index + segment.length;
    }
    return (
      <Box width={columns}>
        <Box width={bandAt} flexShrink={0}>
          {text(0, k)}
        </Box>
        <Band width={inner(columns, bandAt)}>{text(k, l.text.length, l.oneLine ? undefined : inner(columns, bandAt))}</Band>
      </Box>
    );
  }
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
