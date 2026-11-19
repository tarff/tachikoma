// Measurement 7, how often the lesson ask would fire (8d plan, step 12). Not part of Tachikoma: run by hand.
//
//   node scripts/8d/measure-lesson-ask.mjs
//
// Reads the user's Tachikoma transcripts (%LOCALAPPDATA%\tachikoma\sessions\<project>\<id>.jsonl) and error logs
// (%LOCALAPPDATA%\tachikoma\errors\<project>.jsonl: src/cli.tsx:415, projectFile in src/core/datadir.ts:18-26, the
// same sha256 name as the sessions folder, src/core/sessions.ts:13-18), read only, and prints counts alone: no text,
// no session id, no file name and no folder name goes into any output. Starts nothing; needs no MemPalace.
// Subagents' own files (<id>\subagents\*.jsonl) are not read, as in scripts/8d/measure-save.mjs.
//
// The turns are cut by scripts/8d/turns.mjs (step 10's rule), so a background turn is a turn of its own and a Stop
// hook's feedback does not split a turn. Whole turns only: a turn set apart (a damaged line) or marked (the file ends
// mid-turn, a call without a result) is left out of the count, and counted apart by its reason.
//
// Which calls failed. A saved result holds only "error or not" (src/core/types.ts:29), and a declined or cancelled
// call is saved as an error too (src/core/session.ts:1059, 1087, 1106); only a real failure writes a `tool` row to the
// error log (src/core/session.ts:1064), whose text is the tool's name, a space and the input that ran, cut by
// `truncate` (src/core/session.ts:41-43), with no call id. So, as the plan says:
// - the key: for each error result, that same text, the input that ran being a hook's rewrite where the transcript
//   has a `rewritten` line for the call (src/core/transcript.ts:249-256), cut as `truncate` cuts it;
// - one row, one result, in time order, within one session: a row can belong to an error result with its key whose
//   call was sent (its reply's line) no later than the row's time and whose result was saved at or after it. The
//   reply's line is written before its calls run (src/core/session.ts:661, :1320-1324), and the row while the call
//   runs, so both are stamped by the same clock to the millisecond and a tie counts as "before". A row with one such
//   result confirms it, and a confirmed result is no row's again; a row with more than one makes all of them
//   "unclear", counted apart and not as failures.
//
// The count, by the design's rule for the same job (section 5): a command (the `shell` tool), the same program, its
// first word; a file edit (`write_file` or `edit_file`), the same file, its path resolved against the session's
// project folder and compared without regard to letter case, as on Windows; otherwise the same tool. A turn asks
// when a failed call is followed, later in the turn's order of calls, by a call doing the same job whose result is no
// error. Low: unclear results are not failures; high: they are. A turn asks once at most.
//
// A branch (src/core/sessions.ts:95-103) copies a transcript whole with a new id, its lines' times kept, so its copied
// turns would be counted twice and their error results would find no row (the rows carry the first session's id). A
// transcript whose start line has the same time as another in the same project folder is taken as a copy; its turns
// whose first line is one of the earlier transcript's (by file creation time) are left out as "copied by a branch".
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { turnsOf } from "./turns.mjs";

// The session's cap and cut (src/exec/executor.ts:5, src/core/session.ts:41-43); tests/memory/turns.test.ts checks the
// cut against the code's.
export const MAX_TOOL_OUTPUT = 30_000;
export function truncate(s) {
  return s.length <= MAX_TOOL_OUTPUT ? s
    : `${s.slice(0, MAX_TOOL_OUTPUT)}\n[cut: ${s.length - MAX_TOOL_OUTPUT} more characters]`;
}
// The error log's text for a call (src/core/session.ts:1064).
export const keyOf = (name, input) => truncate(`${name} ${JSON.stringify(input)}`);

const time = (iso) => Date.parse(iso);

// A turn's calls in order, each with the input that ran, when its reply was saved (`sent`), and its result's saved
// time and error flag (`saved` unset for a call with no result). A `rewritten` line goes with the call of its id in
// the reply just before it (src/core/transcript.ts:249-256); a result with the first call of its id in that reply.
function callsOf(lines) {
  const out = [];
  let reply = null;
  for (const l of lines) {
    if (l.t === "message" && l.message.role === "assistant") {
      reply = l.message.parts.filter((p) => p.type === "tool_call").map((p) =>
        ({ id: p.id, name: p.name, input: p.input, sent: l.at, saved: undefined, isError: false, state: null }));
      out.push(...reply);
    } else if (l.t === "rewritten" && reply) {
      for (const c of reply) if (c.id === l.id) c.input = l.input;
    } else if (l.t === "message") {
      for (const p of reply ? l.message.parts : []) {
        const c = p.type === "tool_result" && reply.find((x) => x.id === p.callId && x.saved === undefined);
        if (c) Object.assign(c, { saved: l.at, isError: p.isError === true });
      }
      reply = null;
    }
  }
  return out;
}

const FILE_EDITS = new Set(["write_file", "edit_file"]);
const firstWord = (command) => (typeof command === "string" ? command.trim().split(/\s+/)[0] || undefined : undefined);
const samePath = (a, b, project) => typeof a === "string" && typeof b === "string" &&
  path.resolve(project ?? "", a).toLowerCase() === path.resolve(project ?? "", b).toLowerCase();

// The design's rule for the same job (section 5), on the inputs that ran.
function sameJob(a, b, project) {
  if (a.name === "shell" || b.name === "shell") {
    const w = firstWord(a.input?.command);
    return a.name === b.name && w !== undefined && w === firstWord(b.input?.command);
  }
  if (FILE_EDITS.has(a.name) && FILE_EDITS.has(b.name)) return samePath(a.input?.path, b.input?.path, project);
  return a.name === b.name;
}

// One session: its transcript's text and its own `tool` rows of the error log. `copied`: the first lines of turns
// another transcript holds, which a branch copied here. Returns, per whole turn, its kind, its first line's time,
// whether it has a confirmed failure (`failed`; `failedHigh` with unclear ones too) and whether it would ask (`low`,
// `high`; `ceiling` with every error result a failure; `anyLater` by option B's looser rule); the turns left out, by
// reason; the error results and rows by
// outcome; each call's state (null, "confirmed" or "unclear"); and `starts`, its turns' first lines, for a branch made
// from it.
export function asksOf(text, rows, copied = new Set()) {
  let project;
  try {
    project = JSON.parse(text.slice(0, text.indexOf("\n") >>> 0)).project;
  } catch {}
  const r = turnsOf(text);
  const left = {};
  const leave = (reason) => (left[reason] = (left[reason] ?? 0) + 1);
  for (const a of r.apart) leave(a.reason);
  const calls = [];
  const whole = [];
  const starts = [];
  for (const t of r.turns) {
    const start = JSON.stringify(t.lines[0]);
    starts.push(start);
    if (copied.has(start)) {
      leave("copied by a branch");
      continue;
    }
    const seq = callsOf(t.lines);
    calls.push(...seq);
    if (t.mark) leave(t.mark);
    else whole.push({ t, seq });
  }
  const errors = calls.filter((c) => c.saved !== undefined && c.isError);
  for (const e of errors) e.key = keyOf(e.name, e.input);
  const byRow = { total: rows.length, confirmed: 0, unclear: 0, onUnclear: 0, none: 0 };
  for (const w of [...rows].sort((a, b) => time(a.at) - time(b.at))) {
    const at = time(w.at);
    const could = errors.filter((e) => e.state !== "confirmed" && e.key === w.attempted && time(e.sent) <= at &&
      at <= time(e.saved));
    if (!could.length) byRow.none++;
    else if (could.length > 1) {
      for (const e of could) e.state = "unclear";
      byRow.unclear++;
    } else if (could[0].state === "unclear") byRow.onUnclear++;
    else {
      could[0].state = "confirmed";
      byRow.confirmed++;
    }
  }
  const turns = whole.map(({ t, seq }) => {
    const asks = (failed) => seq.some((c, i) => failed(c) &&
      seq.slice(i + 1).some((d) => d.saved !== undefined && !d.isError && sameJob(c, d, project)));
    const confirmed = (c) => c.state === "confirmed";
    const either = (c) => c.state !== null;
    // Beyond the plan's figures, a bound: every error result a failure, matched or not, declined and cancelled ones
    // among them.
    const anyError = (c) => c.saved !== undefined && c.isError;
    // Option B's looser rule (step 12's review): a confirmed failure followed later in the turn by any call that
    // worked, whatever its job.
    const anyLater = seq.some((c, i) => confirmed(c) && seq.slice(i + 1).some((d) => d.saved !== undefined &&
      !d.isError));
    return { kind: t.kind, start: t.lines[0].at, failed: seq.some(confirmed), failedHigh: seq.some(either),
      low: asks(confirmed), high: asks(either), ceiling: asks(anyError), anyLater };
  });
  const results = { errors: errors.length, confirmed: errors.filter((e) => e.state === "confirmed").length,
    unclear: errors.filter((e) => e.state === "unclear").length, noRow: errors.filter((e) => e.state === null).length };
  return { turns, left, damagedOutside: r.damagedOutside, results, rows: byRow,
    calls: calls.map((c) => ({ state: c.state })), starts };
}

// ---- the run, on the user's files ----

const DATA = path.join(process.env.LOCALAPPDATA ?? "", "tachikoma");
// A folder's entries with their types; none when it is not there (step 12's review).
const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
};
// A subagent's failure reaches the lead's log with its task id in front (src/core/tasks.ts:371), and its calls are in
// its own file, which is not read: such rows are counted apart.
const SUBAGENT = /^t\d+: /;

const add = (into, from) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};
const pad = (n) => String(n).padStart(2, "0");
// The day of use, on this PC's clock.
const dayOf = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const lines = (text) => text.split("\n").filter((l) => l.trim());

// The counts over Tachikoma's data folder `data`: its `sessions` and `errors` folders.
export function run(data = DATA) {
  const SESSIONS = path.join(data, "sessions");
  const ERRORS = path.join(data, "errors");
  const s = { projects: 0, files: 0, sessions: 0, notSessions: 0, print: 0, branchCopies: 0, noLog: 0, logNoRows: 0,
    left: {}, damagedOutside: 0, results: {}, rows: {}, subagentRows: 0, badLogLines: 0, rowsNoSession: 0,
    rowsOtherSessions: 0, logsRead: 0, noRowNoLog: 0 };
  const tally = () => ({ typed: 0, background: 0, failed: 0, failedHigh: 0, low: 0, high: 0, ceiling: 0,
    anyLater: 0 });
  const all = tally();
  const perSession = [];
  const perDay = new Map();
  const logs = new Set(entries(ERRORS).filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name));
  for (const d of entries(SESSIONS)) {
    if (!d.isDirectory()) continue;
    s.projects++;
    const dir = path.join(SESSIONS, d.name);
    const sessions = [];
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      s.files++;
      const file = path.join(dir, f.name);
      const text = readFileSync(file, "utf8");
      let first;
      try {
        first = JSON.parse(text.slice(0, text.indexOf("\n") >>> 0));
      } catch {}
      if (first?.t !== "start") {
        s.notSessions++;
        continue;
      }
      sessions.push({ text, id: first.id, at: first.at, print: first.print === true,
        born: statSync(file).birthtimeMs });
    }
    const log = `${d.name}.jsonl`;
    let rows = [];
    if (logs.has(log)) {
      s.logsRead++;
      for (const l of lines(readFileSync(path.join(ERRORS, log), "utf8"))) {
        try {
          const w = JSON.parse(l);
          if (w?.kind === "tool" && typeof w.attempted === "string" && typeof w.at === "string") rows.push(w);
        } catch {
          s.badLogLines++;
        }
      }
    }
    const ids = new Set(sessions.map((x) => x.id));
    s.rowsNoSession += rows.filter((w) => typeof w.session !== "string").length;
    s.rowsOtherSessions += rows.filter((w) => typeof w.session === "string" && !ids.has(w.session)).length;
    // A branch's copy after its first: same start time, made later.
    sessions.sort((a, b) => time(a.at) - time(b.at) || a.born - b.born);
    const groups = new Map();
    for (const x of sessions) {
      s.sessions++;
      if (x.print) s.print++;
      if (!logs.has(log)) s.noLog++;
      const group = groups.get(x.at);
      if (group) s.branchCopies++;
      const own = rows.filter((w) => w.session === x.id);
      if (logs.has(log) && !own.length) s.logNoRows++;
      s.subagentRows += own.filter((w) => SUBAGENT.test(w.attempted)).length;
      const a = asksOf(x.text, own.filter((w) => !SUBAGENT.test(w.attempted)), group ?? new Set());
      groups.set(x.at, new Set([...(group ?? []), ...a.starts]));
      add(s.left, a.left);
      s.damagedOutside += a.damagedOutside;
      add(s.results, a.results);
      if (!logs.has(log)) s.noRowNoLog += a.results.noRow;
      add(s.rows, a.rows);
      const mine = tally();
      for (const t of a.turns) {
        const day = perDay.get(dayOf(t.start)) ?? { ...tally(), sessions: new Set() };
        perDay.set(dayOf(t.start), day);
        day.sessions.add(x);
        for (const into of [all, mine, day]) {
          into[t.kind]++;
          into.failed += t.failed ? 1 : 0;
          into.failedHigh += t.failedHigh ? 1 : 0;
          into.low += t.low ? 1 : 0;
          into.high += t.high ? 1 : 0;
          into.ceiling += t.ceiling ? 1 : 0;
          into.anyLater += t.anyLater ? 1 : 0;
        }
      }
      perSession.push({ at: x.at, print: x.print, ...mine });
    }
  }
  return { s, all, perSession: perSession.sort((a, b) => time(a.at) - time(b.at)), perDay };
}

function show({ s, all, perSession, perDay }) {
  const say = (line) => console.log(line);
  const offset = -new Date().getTimezoneOffset() / 60;
  say(`measure-lesson-ask ${new Date().toISOString()}; days on this PC's clock ` +
    `(UTC${offset >= 0 ? "+" : ""}${offset})`);
  say(`project folders ${s.projects}; transcripts ${s.files}; sessions ${s.sessions} (of them -p runs ${s.print}); ` +
    `not sessions ${s.notSessions}; branch copies ${s.branchCopies}`);
  say(`error logs read ${s.logsRead}; sessions with no error log ${s.noLog}; sessions with a log but no rows of ` +
    `theirs ${s.logNoRows}; unreadable log lines ${s.badLogLines}`);
  say(`whole turns: typed ${all.typed}, background ${all.background}; left out ${JSON.stringify(s.left)}; damaged ` +
    `lines before a first turn ${s.damagedOutside}`);
  say(`error results ${JSON.stringify(s.results)}; of those with no row, in sessions with no error log ` +
    `${s.noRowNoLog}`);
  say(`tool rows of these sessions, by outcome ${JSON.stringify(s.rows)}; from subagents ${s.subagentRows}; with no ` +
    `session id ${s.rowsNoSession}; of sessions with no transcript here ${s.rowsOtherSessions}`);
  say(`turns with a confirmed failure ${all.failed} (with unclear ones ${all.failedHigh}); turns that would ask: low ` +
    `${all.low}, high ${all.high}; ceiling, every error result a failure, ${all.ceiling}; option B, a confirmed ` +
    `failure then any later success in the turn, ${all.anyLater}`);
  say("per session, by start time (n, -p, typed, background, failed, failed with unclear, low, high):");
  for (const [i, x] of perSession.entries()) {
    say(`  ${i + 1} ${x.print ? "p" : "-"} ${x.typed} ${x.background} ${x.failed} ${x.failedHigh} ${x.low} ${x.high}`);
  }
  say("per day of use (sessions with a whole turn, typed, background, failed, failed with unclear, low, high):");
  const days = [...perDay].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [day, x] of days) {
    say(`  ${day} ${x.sessions.size} ${x.typed} ${x.background} ${x.failed} ${x.failedHigh} ${x.low} ${x.high}`);
  }
  const n = days.length;
  const per = (k) => (n ? Math.round((k / n) * 100) / 100 : "-");
  say(`days of use ${n}; asks per day of use: low ${per(all.low)}, high ${per(all.high)}, ceiling ` +
    `${per(all.ceiling)}; most in one day: low ${Math.max(0, ...days.map(([, x]) => x.low))}, high ` +
    `${Math.max(0, ...days.map(([, x]) => x.high))}, ceiling ${Math.max(0, ...days.map(([, x]) => x.ceiling))}`);
  say(`option B per day of use ${per(all.anyLater)}; most in one day ` +
    `${Math.max(0, ...days.map(([, x]) => x.anyLater))}`);
}

// A failure says its code alone, as its message or stack could name a file of the user's.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    show(run());
  } catch (err) {
    console.error(`measure-lesson-ask failed: ${err?.code ?? err?.name ?? "error"}`);
    process.exitCode = 1;
  }
}
