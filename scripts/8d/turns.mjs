// The rule for cutting a saved transcript into turns, for the measurements of steps 10, 12 and 14 (8d plan, step 10).
// Not part of Tachikoma. Transcripts saved before release 8d hold no turn boundary, so the measurements cut them into
// turns themselves, all by this one rule, which is the code's own rule for where a turn starts: `lastTurn`,
// src/tui/describe.ts:288-297. A turn starts at a user message that holds no tool result and is not a Stop hook's
// feedback (src/core/session.ts:691-695); a Stop hook's feedback keeps the turn going, and so does a user message of
// tool results. A turn runs to the next such start. A typed turn's starting message holds typed words; a background
// turn's holds none (the model answering a finished background command or subagent, `session.send("", signal)`,
// src/clilib.ts:321) and is a turn of its own, never joined to the typed turn before it. A shortening's own line is not
// a message and starts nothing; its summary is no part of any turn.
//
// What a turn holds, by the user's answers to Q4 and Q5 (2026-11-19): the typed words, each picture as its marker and
// none of the text hooks, subagents, servers or notes added (as session.ts:513-515 and transcript.ts's `own` take
// them); and all of the model's text in the turn, in order, tool calls and their outputs left out. `n` is a typed
// turn's place among the session's typed prompts, counted from 1, as `Session.prompts` counts them (transcript.ts:248).
//
// A turn that cannot be rebuilt is set apart with its reason, in this order: a damaged line inside it; the file ends in
// the middle of it (the file's last turn, unless its last message is a reply with no calls); a call left without a
// result (a crash: the message after the call's reply is not a user message holding a result for each call).

// The session's own heading for a Stop hook's feedback (src/core/session.ts:68) and a picture's marker
// (src/core/types.ts:42); tests/memory/turns.test.ts checks both against the code.
export const FEEDBACK = "Stop hook feedback:";
export const marker = (id) => `[Image #${id}]`;

const isMessage = (m) =>
  (m?.role === "user" || m?.role === "assistant") && Array.isArray(m.parts) &&
  m.parts.every((p) => typeof p?.type === "string");

// One row per line, as transcript.ts's `parse` splits them; undefined for a line that is not JSON, has no kind or
// time, or is a message line without a message. Lines of other kinds are kept and play no part in the turns.
function rows(text) {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all.map((row) => {
    try {
      const l = JSON.parse(row);
      if (typeof l?.t !== "string" || typeof l.at !== "string") return undefined;
      if ((l.t === "message" || l.t === "shortened") && !isMessage(l.message)) return undefined;
      return l;
    } catch {
      return undefined;
    }
  });
}

const own = (p) =>
  p.type === "image" && p.from === undefined ? [marker(p.id)]
  : p.type === "text" && p.from === undefined ? [p.text]
  : [];
const words = (m) => m.parts.flatMap(own).join("");
const feedback = (m) => m.parts[0]?.type === "text" && m.parts[0].from === "hooks" &&
  m.parts[0].text.startsWith(`${FEEDBACK}\n`);
const starts = (m) => m.role === "user" && !m.parts.some((p) => p.type === "tool_result") && !feedback(m);
const calls = (m) => (m.role === "assistant" ? m.parts.filter((p) => p.type === "tool_call") : []);

// The turns of a transcript's text: `turns`, those rebuilt; `apart`, those set apart, with their reason; and
// `damagedOutside`, damaged lines before the first turn.
export function turnsOf(text) {
  const all = rows(text);
  const spans = [];
  let damagedOutside = 0;
  for (const l of all) {
    if (l?.t === "message" && starts(l.message)) spans.push({ start: l.message, lines: [l], damaged: false });
    else if (!spans.length) damagedOutside += l === undefined ? 1 : 0;
    else if (l === undefined) spans.at(-1).damaged = true;
    else spans.at(-1).lines.push(l);
  }
  const turns = [];
  const apart = [];
  let n = 0;
  for (const [i, s] of spans.entries()) {
    const typed = words(s.start);
    const kind = typed ? "typed" : "background";
    const head = kind === "typed" ? { kind, n: ++n } : { kind };
    const messages = s.lines.filter((l) => l.t === "message").map((l) => l.message);
    const last = messages.at(-1);
    const unanswered = messages.some((m, j) => {
      const ids = calls(m).map((c) => c.id);
      if (!ids.length) return false;
      const next = messages[j + 1] ?? spans[i + 1]?.start;
      return next?.role !== "user" || !ids.every((id) => next.parts.some((p) => p.type === "tool_result" &&
        p.callId === id));
    });
    let reason = null;
    if (s.damaged) reason = "damaged line";
    else if (i === spans.length - 1 && !(last.role === "assistant" && !calls(last).length)) {
      reason = "file ends mid-turn";
    } else if (unanswered) reason = "call without a result";
    if (reason) {
      apart.push({ ...head, reason });
      continue;
    }
    const texts = messages.flatMap((m) =>
      m.role === "assistant" ? m.parts.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])) : []);
    turns.push({ ...head, typed, texts, calls: messages.reduce((k, m) => k + calls(m).length, 0), lines: s.lines });
  }
  return { turns, apart, damagedOutside };
}

// A long turn's text cut into parts of at most `limit` characters, counted as Node counts a string's length, which is
// never fewer than MemPalace counts for the same text (it counts code points). Every part but the last is as long as
// the limit allows; a cut never falls between the two halves of a character Node holds as a pair, and that part ends
// one short instead (8d plan, step 22, Q26).
export function cut(text, limit) {
  const out = [];
  let at = 0;
  while (text.length - at > limit) {
    let end = at + limit;
    const c = text.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    out.push(text.slice(at, end));
    at = end;
  }
  out.push(text.slice(at));
  return out;
}
