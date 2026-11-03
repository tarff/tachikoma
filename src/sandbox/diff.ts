// Copy mode's diff, for the review's detail view (release 7 plan, Task 18; choice 25: Tachikoma's own line diff, with
// no new package and no program run). Lines are compared by Myers' algorithm ("An O(ND) Difference Algorithm and Its
// Variations", 1986), in its linear-space form, as git's xdiff and GNU diff use it, so a large file never needs a table
// of every step. Hunks are shown as git and GNU diff show them (GNU diffutils manual, "Detailed Unified Format").
import { BINARY_TEST_BYTES } from "../tools/search.js";
import type { Line } from "../tui/describe.js";

// The spec's "three lines of context around each change".
const CONTEXT = 3;

// git's test for a binary file: a zero byte in the first 8,000 (search.ts).
export const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_TEST_BYTES).includes(0);

// A file's diff: one row of sizes for a binary file, its lines otherwise. Either side may be empty, for an added or a
// deleted file.
export function fileDiff(before: Buffer, after: Buffer): Line[] {
  if (isBinary(before) || isBinary(after)) return [{ text: `binary file: ${before.length} bytes before, ${after.length} after` }];
  return lineDiff(before.toString("utf8"), after.toString("utf8"));
}

// One line as compared: its text, and whether it is a last line with no new line after it, which makes it a different
// line from the same text with one, as git sees it.
interface Text { lines: string[]; ids: number[]; open: boolean }

function split(text: string, ids: Map<string, number>): Text {
  const lines = text === "" ? [] : text.split("\n");
  const open = lines.length > 0 && lines.at(-1) !== "";
  if (!open) lines.pop();
  const id = (key: string) => ids.get(key) ?? ids.set(key, ids.size).size - 1;
  // A line that ends in a new line is keyed with it, so the last line without one never matches it.
  return { lines, ids: lines.map((l, i) => id(open && i === lines.length - 1 ? l : `${l}\n`)), open };
}

export function lineDiff(before: string, after: string): Line[] {
  const ids = new Map<string, number>();
  const a = split(before, ids);
  const b = split(after, ids);
  const gone = new Uint8Array(a.ids.length);
  const added = new Uint8Array(b.ids.length);
  compare(a.ids, b.ids, 0, a.ids.length, 0, b.ids.length, gone, added);

  // The rows in order: within each change, the removed lines before the added ones, as git shows them. `i` and `j` are
  // each row's place in the two texts.
  type Row = { mark: " " | "-" | "+"; i: number; j: number };
  const rows: Row[] = [];
  for (let i = 0, j = 0; i < a.ids.length || j < b.ids.length; ) {
    if (i < a.ids.length && gone[i]) rows.push({ mark: "-", i: i++, j });
    else if (j < b.ids.length && added[j]) rows.push({ mark: "+", i, j: j++ });
    else rows.push({ mark: " ", i: i++, j: j++ });
  }

  const lines: Line[] = [];
  for (let at = 0; at < rows.length; ) {
    while (at < rows.length && rows[at]!.mark === " ") at++;
    if (at === rows.length) break;
    // A hunk runs from the change's context to the last change whose context touches the next's: GNU diff joins two
    // changes with no more than twice the context of unchanged lines between them.
    const start = Math.max(0, at - CONTEXT);
    let end = at;
    for (let k = at; k < rows.length && k - end - 1 <= 2 * CONTEXT; k++) if (rows[k]!.mark !== " ") end = k;
    const stop = Math.min(rows.length, end + 1 + CONTEXT);
    const hunk = rows.slice(start, stop);
    const from = rows[start]!;
    const oldCount = hunk.filter((r) => r.mark !== "+").length;
    const newCount = hunk.filter((r) => r.mark !== "-").length;
    lines.push({ text: `@@ -${range(from.i, oldCount)} +${range(from.j, newCount)} @@`, color: "cyan" });
    for (const r of hunk) {
      const [text, open] = r.mark === "+" ? [b.lines[r.j]!, b.open && r.j === b.lines.length - 1] : [a.lines[r.i]!, a.open && r.i === a.lines.length - 1];
      lines.push(r.mark === " " ? { text: ` ${text}` } : { text: `${r.mark}${text}`, color: r.mark === "-" ? "red" : "green" });
      if (open) lines.push({ text: "\\ No newline at end of file" }); // git's and GNU diff's own marker
    }
    at = stop;
  }
  return lines;
}

// A hunk's range, from the place `at` (counted from 0) of its first line: `start,count`, with the count left out when it
// is 1, and an empty range starting at the line before it (GNU diffutils manual, "Detailed Unified Format").
const range = (at: number, count: number) => (count === 0 ? `${at},0` : count === 1 ? `${at + 1}` : `${at + 1},${count}`);

// Marks the lines of a[aLo, aHi) not in a shortest edit to b[bLo, bHi) in `gone`, and the lines of b not in it in
// `added`. Lines alike at either end are taken off first; what is left is split at the middle of a shortest edit,
// found from both ends at once, and each half done the same way.
function compare(a: number[], b: number[], aLo: number, aHi: number, bLo: number, bHi: number, gone: Uint8Array, added: Uint8Array): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) (aLo++, bLo++);
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) (aHi--, bHi--);
  if (aLo === aHi) return void added.fill(1, bLo, bHi);
  if (bLo === bHi) return void gone.fill(1, aLo, aHi);
  const [x, y] = middle(a, b, aLo, aHi, bLo, bHi);
  compare(a, b, aLo, aLo + x, bLo, bLo + y, gone, added);
  compare(a, b, aLo + x, aHi, bLo + y, bHi, gone, added);
}

// The place, relative to (aLo, bLo), where the paths of a shortest edit from the start and from the end first meet:
// Myers' middle snake, as diff-match-patch's bisect walks it. `forward[k]` is the furthest x the path from the start has
// reached on diagonal k (x - y); `backward[k]` the same from the end, counted backwards. Both ends differ here, so
// neither half it gives is the whole.
function middle(a: number[], b: number[], aLo: number, aHi: number, bLo: number, bHi: number): [number, number] {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const most = Math.ceil((n + m) / 2);
  const offset = most;
  const forward = new Int32Array(2 * most + 2).fill(-1);
  const backward = new Int32Array(2 * most + 2).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const delta = n - m;
  // With an odd difference in length the paths meet on a forward step, with an even one on a backward step.
  const odd = delta % 2 !== 0;
  let fStart = 0;
  let fEnd = 0;
  let bStart = 0;
  let bEnd = 0;
  for (let d = 0; d < most; d++) {
    for (let k = -d + fStart; k <= d - fEnd; k += 2) {
      const at = offset + k;
      let x = k === -d || (k !== d && forward[at - 1]! < forward[at + 1]!) ? forward[at + 1]! : forward[at - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) (x++, y++);
      forward[at] = x;
      if (x > n) fEnd += 2; // off the right of the grid
      else if (y > m) fStart += 2; // off the bottom
      else if (odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < backward.length && backward[other] !== -1 && x >= n - backward[other]!) return [x, y];
      }
    }
    for (let k = -d + bStart; k <= d - bEnd; k += 2) {
      const at = offset + k;
      let x = k === -d || (k !== d && backward[at - 1]! < backward[at + 1]!) ? backward[at + 1]! : backward[at - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) (x++, y++);
      backward[at] = x;
      if (x > n) bEnd += 2;
      else if (y > m) bStart += 2;
      else if (!odd) {
        const other = offset + delta - k;
        if (other >= 0 && other < forward.length && forward[other] !== -1) {
          const fx = forward[other]!;
          if (fx >= n - x) return [fx, fx - (other - offset)];
        }
      }
    }
  }
  // Never reached: two paths through a grid always meet by its middle step. Splitting at the start would loop, so the
  // whole is taken as replaced.
  return [n, 0];
}
