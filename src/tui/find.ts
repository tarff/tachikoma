// The detail view's search (release 5 design, "The detail view"): every place the query is found in the lines, in order,
// in any case, as Ctrl+R's history search, and as plain text, not a pattern. A line's matches do not overlap.
export interface Found {
  line: number;
  start: number;
  end: number; // after the match: places are between characters (view.ts, Pos)
}

export function find(lines: readonly { text: string }[], query: string): Found[] {
  if (!query) return [];
  // The pattern's own characters escaped, so the query is matched as typed; "u" makes "i" fold case beyond ASCII.
  const pattern = new RegExp(query.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"), "giu");
  return lines.flatMap((l, line) => [...l.text.matchAll(pattern)].map((m) => ({ line, start: m.index, end: m.index + m[0].length })));
}
