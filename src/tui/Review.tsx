import { constants } from "node:buffer";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Box, Text, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import type { Protection } from "../core/permissions.js";
import { errorText } from "../core/types.js";
import { protectedPart } from "../safety/protected.js";
import { type ApplyOptions, appliedSoFar, applyChange, CANNOT_MERGE, type Outcome } from "../sandbox/apply.js";
import { type Change, changes } from "../sandbox/changes.js";
import { fileDiff } from "../sandbox/diff.js";
import { type Manifest, removeCopy } from "../sandbox/snapshot.js";
import { type Bindings, type Context, strokeOf } from "./bindings.js";
import { type Line, screen } from "./describe.js";
import { type Detail, DetailView, opened } from "./DetailView.js";
import { both, named, pieces } from "./keys.js";
import { FOLLOWING, scrollBy, scrollTo, wrap } from "./view.js";

// The review of a copy's changes (release 7 plan, Task 20; choices 26, 27 and 109): the list of what the box changed,
// each kept or skipped, its diff in the detail view, then apply (Task 19), later, or discard. It reads its own keys, so
// the session's end (Task 21's leave()) and `tachi review` can each draw it, the first with the App's own keys turned
// off. Every path, diff row and error is the box's text, or holds it, so all of it is drawn through describe.ts's
// screen(), which escapes control characters.

// A copy waiting for review: its session, its folder (`copies/<session>/` in the data folder, with base/, work/,
// manifest.json, and applied.jsonl once an apply has begun) and its manifest.
export interface ReviewCopy { session: string; folder: string; manifest: Manifest }
// What came of one change: Task 19's outcome, or a failure applyChange rejected with, such as a full disk.
export type Done = Outcome | { path: string; result: "failed"; why: string };
// How the review ended, for the caller: how the user left it, what came of each change applied or skipped, whether the
// copy was removed, and the screen's last lines, to say again once the screen is gone. The lines and the outcomes' paths
// and whys hold the box's text, so they come escaped, as the screen drew them (describe.ts, screen), and can be printed
// as they are.
export interface ReviewEnd { how: "applied" | "later" | "discarded"; outcomes: Done[]; removed: boolean; lines: string[] }

// The plan's words (Task 20).
const top = (n: number, keys: string) => `Review the copy's changes: ${n} file${n === 1 ? "" : "s"}. ${keys}`.trimEnd();
const conflictAsked = (rel: string, keys: string) => `${rel} changed in your folder since the copy was made. ${keys}`;
export const discardAsked = (keys: string) => `Discard the copy and every change in it? [${keys}]`;
// The rest are Task 20's drafts, for the user's approval.
const READING = "Reading the copy's changes...";
const unread = (why: string) => `The copy's changes could not be read: ${why}.`;
export const leftOut = (rel: string, why: string) => `Left out, never applied: ${rel} (${why})`; // the launch's too (clilib.ts)
const ignoredCount = (n: number) => `${n} change${n === 1 ? "" : "s"} in paths git ignores: counted, never applied`;
const APPLYING = "Applying...";
// The finished screen's keys (the user's choice): Up and Down scroll what came of each change, any other key closes.
const closing = (scroll: string | undefined) => (scroll ? `${scroll} scroll · any other key closes` : "Any key closes.");
export const kept = (session: string) => `The copy is kept; tachi review ${session} opens it again.`;
const REMOVED = "The copy was removed.";
export const DISCARDED = "The copy was discarded.";
export const removing = (n: number) => `Removing the copy (${n} file${n === 1 ? "" : "s"})...`;
export const notRemoved = (why: string, folder: string) => `The copy could not be removed (${why}); delete ${folder} by hand.`;
const LINKS_BY_HAND = "links are applied by hand"; // Task 19's why for a link (apply.ts)
const TYPES_BY_HAND = "a path whose type changed is applied by hand";
const NONE = "(none)";
const tooLarge = (before: number, after: number) => `too large to show: ${before} bytes before, ${after} after`;
const noLongerAFile = (rel: string) => `${rel} is no longer a file in the copy`; // Task 19's (choice 113)
const executable = (before: boolean, after: boolean) => `executable: ${before ? "yes" : "no"} before, ${after ? "yes" : "no"} after`;
const NO_LINES = "no lines to show";
const diffUnread = (why: string) => `The diff could not be read: ${why}`;
const PROTECTED = "(protected)"; // after the choice of a change to a protected file (choice 115)

// The kinds' names, which the rows line up after.
const WIDEST = Math.max(...["added", "changed", "deleted", "link", "type"].map((k) => k.length));

// One line of the box's text, escaped, for one row.
const shown = (text: string) => screen({ text, oneLine: true }).text;

// A row of the list: a note (what was left out, the ignored count), or a change with its choice (keep, skip, or null for
// shown only), whether its path is protected, what came of it, and whether its conflict's question is being asked.
type Item = { note: string } | { change: Change; keep: boolean | null; marked: boolean; done?: Done; asking?: boolean };
const isChange = (i: Item): i is Extract<Item, { change: Change }> => "change" in i;
// What a change's row says after its path: its choice before the apply, or what came of it.
function cell(r: Extract<Item, { change: Change }>): string {
  const d = r.done;
  if (r.asking) return "conflict";
  if (!d) return `${r.keep === null ? "shown only" : r.keep ? "keep" : "skip"}${r.marked ? ` ${PROTECTED}` : ""}`;
  if (d.result === "conflict") return d.mergedTo ? `merged with conflicts in ${d.mergedTo}` : `conflict: ${d.why}`;
  if (d.result === "refused") return `not applied: ${d.why}`;
  if (d.result === "failed") return `failed: ${d.why}`;
  return d.result;
}

// The diff of one change, for the detail view (Task 18's fileDiff), read from the copy's base/ and work/. Each file's
// size is checked against Node's longest string before it is read (`most`, a test's smaller), since a larger file cannot
// be held as one string. Links and paths whose type changed are shown as what they were and are (choice 26).
export async function diffOf(c: Change, folder: string, most: number = constants.MAX_STRING_LENGTH): Promise<Line[]> {
  if (!("binary" in c)) {
    // One line each, a line break in a link's target escaped as any other control character (describe.ts, screen).
    return [
      { text: `before: ${c.before ?? NONE}`, oneLine: true },
      { text: `after: ${c.after ?? NONE}`, oneLine: true },
      { text: c.kind === "link" ? LINKS_BY_HAND : TYPES_BY_HAND },
    ];
  }
  // Each side's file, or none for the side an added or deleted file does not have; read without following a link.
  const sizeOf = async (copy: string, has: boolean) => {
    if (!has) return { file: undefined, size: 0 };
    const file = path.join(folder, copy, ...c.path.split("/"));
    const st = await lstat(file);
    return st.isFile() ? { file, size: st.size } : null;
  };
  const sides = [await sizeOf("base", c.kind !== "added"), await sizeOf("work", c.kind !== "deleted")];
  if (sides.some((s) => s === null)) return [{ text: noLongerAFile(c.path) }];
  const [before, after] = sides as { file: string | undefined; size: number }[];
  if (before!.size > most || after!.size > most) return [{ text: tooLarge(before!.size, after!.size) }];
  const read = (s: { file: string | undefined }) => (s.file ? readFile(s.file) : Promise.resolve(Buffer.alloc(0)));
  const lines = fileDiff(await read(before!), await read(after!));
  const flipped = c.execBefore !== undefined && c.execAfter !== undefined && c.execBefore !== c.execAfter;
  return [...(flipped ? [{ text: executable(c.execBefore!, c.execAfter!) }] : []), ...(lines.length ? lines : flipped ? [] : [{ text: NO_LINES }])];
}

export function Review({
  copy,
  bindings,
  onEnd,
  height,
  options,
  remove = removeCopy,
  protection,
}: {
  copy: ReviewCopy;
  bindings: Bindings; // the table of keys, for the Review context's keys and the names the lines give them
  onEnd: (end: ReviewEnd) => void;
  height?: number; // the rows it may draw; the terminal's less the one Ink ends on when not given
  options?: ApplyOptions; // a test's (apply.ts)
  remove?: (folder: string) => Promise<void>; // a test's stand-in for removeCopy
  // The hooks folders, git folders and settings files git's settings name, for which changes are protected beside
  // protected.ts's own lists: host paths, protectionOf(await gitSettings(manifest.root)) (clilib.ts), never the box's
  // view of them (boxProtection), whose /work paths match no host path. Required, so none is left out unseen.
  protection: Protection;
}) {
  const { session, folder, manifest } = copy;
  const { columns, rows } = useWindowSize();
  const h = Math.max(1, height ?? rows - 1);
  // Each key reads and changes this at once, as in ModelPicker: several keys can arrive before the screen is drawn again.
  const state = useRef<{
    stage: "reading" | "unread" | "list" | "busy" | "done";
    items: Item[];
    at: number; // the row chosen
    first: number; // the list's first row on screen
    why?: string; // why the changes could not be read
    diff: Detail | null;
    discard: boolean; // the question before discarding is asked
    answer: ((to: "merge" | "skip" | "stop") => void) | null; // a conflict's question, waiting for m, s or Ctrl-C
    doing?: string; // the row under the list while busy
    end?: ReviewEnd; // once done, waiting for a key
    ended: boolean;
  } | null>(null);
  state.current ??= { stage: "reading", items: [], at: 0, first: 0, diff: null, discard: false, answer: null, ended: false };
  const s = state.current;
  const [, redraw] = useState(0);
  const again = () => redraw((n) => n + 1);
  const ctx = { root: manifest.root, base: path.join(folder, "base"), work: path.join(folder, "work"), manifest, session };

  // The changes, less what an earlier apply of this copy applied (a copy reopened by `tachi review` after a crash lists
  // them again), with what was left out and the ignored count as notes above them (choice 109). Read once, at the first
  // drawing; a discard begun meanwhile goes on, the list never shown.
  useEffect(() => {
    void (async () => {
      try {
        const [found, before] = await Promise.all([changes(manifest, ctx.work), appliedSoFar(session, path.dirname(path.dirname(folder)))]);
        if (s.stage !== "reading") return;
        const applied = new Set(before.filter((o) => o.result === "applied").map((o) => o.path));
        const ignored = found.changes.filter((c) => c.ignored).length;
        // The box's own repository at the top, which Tachikoma made at launch (choice 24), is not listed: it would be in
        // every review (choice 114). One deeper is, and so is a .tachikoma.
        const notes = [...manifest.leftOut, ...found.leftOut.filter((l) => l.path !== ".git")].map((l) => leftOut(l.path, l.why));
        s.items = [
          ...[...notes, ...(ignored ? [ignoredCount(ignored)] : [])].map((note): Item => ({ note })),
          ...found.changes.filter((c) => !c.ignored && !applied.has(c.path)).map((change): Item => {
            // A change to a path the file tools protect, read as protected.ts reads a path in the project, starts as
            // skip, marked (choice 115); the user can still keep it.
            const marked = protectedPart(manifest.root, path.join(manifest.root, ...change.path.split("/")), protection.hooks, protection.files) !== undefined;
            return { change, keep: "binary" in change ? !marked : null, marked };
          }),
        ];
        s.at = Math.max(0, s.items.findIndex(isChange));
        s.stage = "list";
      } catch (err) {
        if (s.stage !== "reading") return;
        s.why = errorText(err);
        s.stage = "unread";
      }
      again();
    })();
  }, []);

  const end = (e: ReviewEnd) => {
    s.ended = true;
    const outcomes = e.outcomes.map(
      (o): Done => ({
        ...o,
        path: shown(o.path),
        ...(o.why === undefined ? {} : { why: shown(o.why) }),
        ...("mergedTo" in o && o.mergedTo !== undefined ? { mergedTo: shown(o.mergedTo) } : {}),
      }),
    );
    onEnd({ ...e, outcomes, lines: e.lines.map(shown) });
  };
  // Shown until a key, then ended.
  const finish = (e: ReviewEnd) => {
    s.stage = "done";
    s.end = e;
    s.doing = undefined;
    again();
  };
  // The copy removed, or why not, in a line. Nothing is left that could be applied half removed (removeCopy). It usually
  // holds node_modules, and can take a while, so a line says so first, counting the manifest's files, not the disk's.
  const removed = async (): Promise<string | null> => {
    s.doing = removing(Object.values(manifest.entries).filter((e) => e.type === "file").length);
    again();
    try {
      await remove(folder);
      return null;
    } catch (err) {
      return notRemoved(errorText(err), folder);
    }
  };
  const later = () => end({ how: "later", outcomes: [], removed: false, lines: [kept(session)] });
  const discard = async () => {
    s.discard = false;
    s.stage = "busy";
    again();
    const why = await removed();
    if (why === null) end({ how: "discarded", outcomes: [], removed: true, lines: [DISCARDED] });
    else finish({ how: "discarded", outcomes: [], removed: false, lines: [why] });
  };

  // One change applied, its failure caught, so one file's error never stops the rest (main design: not all-or-nothing).
  const applyOne = (c: Change, merge: boolean): Promise<Done> =>
    applyChange(c, ctx, merge, options).catch((err): Done => ({ path: c.path, result: "failed", why: errorText(err) }));
  // The kept changes, deletes first: on Windows and macOS a case-only rename in the box (Readme.md to README.md) lists as
  // an add and a delete, and added first, the add is a false conflict and the delete then removes the user's only copy
  // (Task 19's review, measured). A conflict asks whether to merge; a binary one or a delete cannot be merged, and is not
  // asked. Ctrl-C at the question stops there, leaving that change and the rest unapplied. The copy is removed once
  // nothing is left unapplied or unskipped: a change shown only, refused, failed, not reached, or a conflict neither
  // merged nor skipped keeps it.
  const apply = async () => {
    s.stage = "busy";
    s.doing = APPLYING;
    const listed = s.items.filter(isChange);
    for (const r of listed) if (r.keep === false) r.done = { path: r.change.path, result: "skipped" };
    const keep = listed.filter((r) => r.keep === true);
    for (const r of [...keep.filter((r) => r.change.kind === "deleted"), ...keep.filter((r) => r.change.kind !== "deleted")]) {
      s.at = s.items.indexOf(r);
      again();
      r.done = await applyOne(r.change, false);
      if (r.done.result !== "conflict" || r.done.mergedTo !== undefined || !("binary" in r.change) || r.change.binary) continue;
      // A delete's merge can only say this (apply.ts), so it is said at once.
      if (r.change.kind === "deleted") {
        r.done = { ...r.done, why: CANNOT_MERGE };
        continue;
      }
      r.asking = true;
      again();
      const to = await new Promise<"merge" | "skip" | "stop">((resolve) => (s.answer = resolve));
      r.asking = false;
      if (to === "stop") break;
      r.done = to === "merge" ? await applyOne(r.change, true) : { path: r.change.path, result: "skipped" };
    }
    const count = (result: Done["result"]) => listed.filter((r) => r.done?.result === result).length;
    const merged = listed.flatMap((r) => (r.done?.result === "conflict" && r.done.mergedTo ? [r.done.mergedTo] : []));
    const isLeft = (r: (typeof listed)[number]) =>
      r.keep === null || !r.done || r.done.result === "refused" || r.done.result === "failed" || (r.done.result === "conflict" && !r.done.mergedTo);
    const left = listed.filter(isLeft).length;
    const summary = [
      `${count("applied")} applied, ${count("skipped")} skipped`,
      ...(merged.length ? [`${merged.length} merged with conflicts in ${merged.join(", ")}`] : []),
      ...(left ? [`${left} left in the copy`] : []),
    ].join(", ");
    const why = left ? undefined : await removed();
    // Each outcome neither applied nor skipped as its row says it, for the caller to say again once the screen, where
    // a long list scrolls them out of sight, is gone.
    const notable = listed.filter((r) => r.done && r.done.result !== "applied" && r.done.result !== "skipped");
    finish({
      how: "applied",
      outcomes: listed.flatMap((r) => (r.done ? [r.done] : [])),
      removed: why === null,
      lines: [summary, ...notable.map((r) => `${r.change.kind} ${r.change.path} ${cell(r)}`), why === undefined ? kept(session) : (why ?? REMOVED)],
    });
  };

  // Opens the chosen change's diff in the detail view, unless the list has moved on while it was read.
  const showDiff = async (r: Extract<Item, { change: Change }>) => {
    const at = s.at;
    let lines: Line[];
    try {
      lines = await diffOf(r.change, folder);
    } catch (err) {
      lines = [{ text: diffUnread(errorText(err)) }];
    }
    if (s.stage !== "list" || s.at !== at || s.discard || s.diff) return;
    s.diff = opened([{ text: `${r.change.kind} ${r.change.path}`, color: "gray", oneLine: true }, ...lines], columns - 1);
    again();
  };

  // The detail view's keys, as the App's detail view reads them (app/keyRouting.ts, detailKey; app/mouse.ts, scroll),
  // less its search and printing out.
  const viewHeight = Math.max(1, h - 1);
  const diffKey = (a: string | null) => {
    const d = s.diff!;
    const half = Math.max(1, Math.floor(viewHeight / 2));
    const by: Record<string, number> = {
      "transcript:lineDown": 1,
      "scroll:lineDown": 1,
      "transcript:lineUp": -1,
      "scroll:lineUp": -1,
      "scroll:pageDown": half,
      "scroll:pageUp": -half,
    };
    if (a === "transcript:exit" || a === "app:interrupt") s.diff = null;
    else if (a === "transcript:top" || a === "scroll:top") d.view.current = scrollTo(d.rows, d.view.current, viewHeight, 0);
    else if (a === "transcript:bottom" || a === "scroll:bottom") d.view.current = FOLLOWING;
    else if (a !== null && by[a] !== undefined) d.view.current = scrollBy(d.rows, d.view.current, viewHeight, by[a]!);
  };

  // What one key does, by the action it has in the contexts in force, or null for one no binding takes. Ctrl-C, which
  // is reserved, does what Esc or n does in each place; at the list it leaves the copy for later, as `l` does, and at a
  // conflict's question it stops applying, keeping that change and the rest in the copy.
  const act = (a: string | null) => {
    if (s.ended) return;
    if (s.stage === "done") {
      // Up and Down scroll the outcomes; any other key closes.
      if (a === "review:previous") s.at = Math.max(0, s.at - 1);
      else if (a === "review:next") s.at = Math.max(0, Math.min(s.items.length - 1, s.at + 1));
      else return end(s.end!);
      return again();
    }
    if (s.diff) diffKey(a);
    else if (s.discard) {
      if (a === "confirm:yes") return void discard();
      if (a === "confirm:no" || a === "app:interrupt") s.discard = false;
    } else if (s.stage === "busy") {
      const answer = s.answer;
      if (!answer || (a !== "review:merge" && a !== "review:skip" && a !== "app:interrupt")) return;
      s.answer = null;
      answer(a === "review:merge" ? "merge" : a === "review:skip" ? "skip" : "stop");
    } else if (a === "review:later" || a === "app:interrupt") return later();
    else if (a === "review:discard") s.discard = true;
    else if (s.stage === "list") {
      const r = s.items[s.at];
      if (a === "review:previous") s.at = Math.max(0, s.at - 1);
      else if (a === "review:next") s.at = Math.max(0, Math.min(s.items.length - 1, s.at + 1));
      else if (a === "review:toggle" && r && isChange(r) && r.keep !== null) r.keep = !r.keep;
      else if (a === "review:diff" && r && isChange(r)) void showDiff(r);
      else if (a === "review:apply") return void apply();
    }
    again();
  };
  const contexts = (): Context[] => (s.diff ? ["Transcript", "Scroll", "Global"] : s.discard ? ["Confirmation", "Global"] : ["Review", "Global"]);
  // A key a stroke; text read together, such as two quick presses of Space, a stroke a character, as the prompt takes
  // it in vim mode (app/keyRouting.ts, vimTakes).
  useInput((input, key) => {
    const single = strokeOf(input, key);
    const piece = (p: string) => strokeOf(p, p === "\r" ? { ...key, return: true } : { ...key, shift: p !== p.toLowerCase() });
    const each = single ? [single] : key.ctrl || key.meta ? [] : pieces(input).map(piece);
    for (const stroke of each) {
      if (!stroke) continue;
      const before = { discard: s.discard, stage: s.stage };
      const got = bindings.press(stroke, contexts(), Date.now());
      if (!got || !("pending" in got)) act(got?.action ?? null);
      // A stroke that asks the discard question, or begins the apply (whose conflict questions it may ask), ends the
      // read: the rest of a paste such as "dy" must not answer it (Task 20's quality review).
      if ((s.discard && !before.discard) || s.stage !== before.stage) break;
    }
  });

  // The keys' names, from the bindings, as the App's hints name them (keys.ts, named); a part with no key is left out.
  const k = (action: string, context: Context, usual: string) => named(bindings, action, context, [usual])[0];
  const said = (ps: [string | undefined, string][]) => ps.flatMap(([key, words]) => (key === undefined ? [] : [`${key} ${words}`]));
  const parts = (...ps: [string | undefined, string][]) => said(ps).join(" · ");
  const laterKeys = parts([k("review:later", "Review", "l"), "later"], [k("review:discard", "Review", "d"), "discard"]);

  if (s.diff) {
    if (s.diff.rows.width !== columns - 1) s.diff.rows.setWidth(columns - 1);
    const t = (action: string, usual: string) => k(`transcript:${action}`, "Transcript", usual);
    const keys = parts(
      [both(t("lineDown", "j"), t("lineUp", "k")), "line"],
      [both(t("top", "g"), t("bottom", "shift+g")), "top, bottom"],
      [both(k("scroll:pageUp", "Scroll", "pageup"), k("scroll:pageDown", "Scroll", "pagedown")), "page"],
      [named(bindings, "transcript:exit", "Transcript", ["q", "escape"]).join(" ") || undefined, "back"],
    );
    return (
      <>
        <DetailView detail={s.diff} height={viewHeight} selection={null} />
        <Text color="gray" wrap="truncate-end">
          {keys}
        </Text>
      </>
    );
  }

  const listed = s.items.filter(isChange).length;
  const headline =
    s.stage === "reading"
      ? READING
      : s.stage === "unread"
        ? unread(s.why!)
        : s.end?.how === "applied"
          ? s.end.lines[0]!
          : s.stage !== "list"
            ? top(listed, "") // the keys act only at the list
            : top(
              listed,
              parts(
                [k("review:toggle", "Review", "space"), "keep/skip"],
                [k("review:diff", "Review", "enter"), "diff"],
                [k("review:apply", "Review", "a"), "apply"],
                [k("review:later", "Review", "l"), "later"],
                [k("review:discard", "Review", "d"), "discard"],
              ),
            );
  // The keys bound to review:previous and review:next, the arrows by name, as "Up/Down" with the default keys.
  const arrow = (key: string | undefined) => key?.replace("↑", "Up").replace("↓", "Down");
  const scrollKeys = [arrow(k("review:previous", "Review", "up")), arrow(k("review:next", "Review", "down"))].filter(Boolean).join("/") || undefined;
  const asking = s.items.find((i): i is Extract<Item, { change: Change }> => isChange(i) && i.asking === true);
  const footer = s.discard
    ? discardAsked([k("confirm:yes", "Confirmation", "y"), k("confirm:no", "Confirmation", "n")].filter(Boolean).join("/"))
    : s.stage === "done"
      ? `${s.end!.lines.at(-1)} ${closing(scrollKeys)}`
      : asking
        ? conflictAsked(asking.change.path, said([[k("review:merge", "Review", "m"), "to merge"], [k("review:skip", "Review", "s"), "to skip"]]).join(", "))
        : s.stage === "unread" || s.stage === "reading"
          ? laterKeys
          : (s.doing ?? null);
  // The head and foot lines, wrapped to the screen's width as the conversation wraps (view.ts), and the list in the
  // rows between, its window moved only as far as keeps the chosen row in it.
  const lines = (text: string | null) => (text === null ? [] : wrap(shown(text), columns, false).map((w) => w.text));
  const head = lines(headline);
  const foot = lines(footer);
  const room = Math.max(1, h - head.length - foot.length);
  if (s.at < s.first) s.first = s.at;
  if (s.at >= s.first + room) s.first = s.at - room + 1;
  s.first = Math.max(0, Math.min(s.first, s.items.length - room));

  return (
    <>
      {head.map((row, i) => (
        <Text key={`h${i}`} wrap="truncate-end">
          {row}
        </Text>
      ))}
      {s.items.slice(s.first, s.first + room).map((item, i) => {
        const chosen = s.first + i === s.at && s.stage !== "reading" && s.stage !== "unread";
        // A long path gives up its middle first; the choice or outcome after it is cut only where it alone does not fit
        // beside the kind and one column of the path.
        return isChange(item) ? (
          <Box key={s.first + i} height={1}>
            <Box flexShrink={0}>
              <Text inverse={chosen}>{`${item.change.kind.padEnd(WIDEST)}  `}</Text>
            </Box>
            <Box flexShrink={1}>
              <Text inverse={chosen} wrap="truncate-middle">
                {shown(item.change.path)}
              </Text>
            </Box>
            <Box flexShrink={0} maxWidth={Math.max(1, columns - WIDEST - 3)}>
              <Text inverse={chosen} wrap="truncate-end">{`  ${shown(cell(item))}`}</Text>
            </Box>
          </Box>
        ) : (
          <Text key={s.first + i} color="gray" inverse={chosen} wrap="truncate-end">
            {shown(item.note)}
          </Text>
        );
      })}
      {foot.map((row, i) => (
        <Text key={`f${i}`} color={s.discard || asking ? "yellow" : undefined} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </>
  );
}
