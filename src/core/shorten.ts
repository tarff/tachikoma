import type { Workspace } from "../exec/workspace.js";
import type { Cache } from "../providers/pictures.js";
import { callText } from "./exportText.js";
import { characters, fits, type Sizes } from "./fit.js";
import { errorText, type Message, type Part, type Provider, sentAll, type ToolSpec, type Usage } from "./types.js";

// Shortening a conversation into one message (release 8a design, "How shortening works", steps 3-5; plan, choices 22-23).

// Where the turn is, which decides what is kept whole (design, step 4).
export type When = "between" | "start" | "during";

// Why a shortening failed, for the red line "The conversation could not be shortened (<reason>); it is unchanged." A
// provider's own error text, or its refusal's detail, goes there as it came; these are the rest.
export const CANCELLED = "cancelled by the user";
export const EMPTY_SUMMARY = "the summary came back empty";
export const ONE_EXCHANGE = "one exchange is too long to summarise";
export const COMBINED_TOO_LONG = "the summaries of its pieces are too long to combine";
export const NOTHING = "there is nothing to summarise";
export const PROMPT_TOO_BIG = "the request being worked on does not fit the window on its own";
export const STILL_TOO_BIG = "even shortened, it does not fit the window";

// The summary instructions, approved word for word (design, "The summary instructions").
export const INSTRUCTIONS =
  'Summarise this conversation so work can carry on from the summary alone. First, under "Your instructions", copy word ' +
  'for word every instruction, limit or preference the user gave, such as "don\'t push". Then cover: what the user asked ' +
  "for; what has been done, with file paths; decisions made and why; errors met and how they were fixed; what is still to " +
  "do; and what was being worked on at the end.";

// What a later piece of a split part opens with, to the model (user, 2026-11-06, option chosen: "Cut anywhere, add a
// line"): Anthropic refuses a request whose first message is a reply.
export const LATER_PART = "This is the later part of a conversation; the part before it is summarised separately.";

// Claude Code's figures (design, step 5; choice 22).
const FILES = 5;
const FILE_TOKENS = 5000; // the approved "over 5,000 tokens" line repeats it, written out as approved
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

export interface Shortening {
  lead: Provider;
  system: string;
  messages: Message[];
  // during: the message that started this turn, as the session holds it (after a shortening it is no longer in
  // `messages`, whose first message is then the last shortening's new history).
  asked?: Message;
  tools: ToolSpec[];
  calls: { name: string; input: unknown }[];
  workspace: Workspace;
  sizes: Sizes;
  window: number;
  focus?: string;
  signal?: AbortSignal;
  // The session's shrunk pictures and its "send without pictures" answer for the lead, so a summary of a history with
  // pictures is sent as the conversation's requests are (Task 12's notes from Task 11's reviews).
  shrunk?: Cache;
  refusedBy?: string;
  onUsage: (u: { provider: string; usage: Usage; priceKnown?: boolean }) => void; // each summary request's usage, as soon as it ends
}

// A reason to stop, carried out of the summary's pieces to shorten() itself.
class Problem extends Error {}

// The new history, or why there is none. Nothing is changed here: the caller (Task 12) replaces the history only with
// what comes back, and keeps the old one on a problem (design, "Carried over from the main design").
export async function shorten(s: Shortening, when: When): Promise<{ messages: Message[]; summary: string } | { problem: string }> {
  const { messages } = s;
  // What is kept whole: the prompt in progress at the start of a turn or during one, and during one its latest round,
  // that reply with its calls' results, as text. Each option is the part summarised and the round kept, the second
  // option for when the round does not fit: then it goes into the summary too, a complete exchange (step 4).
  let prompt: Part[] | undefined;
  let options: { part: Message[]; round?: string }[];
  if (when === "between") options = [{ part: messages }];
  else if (when === "start") {
    prompt = messages.at(-1)!.parts;
    options = [{ part: messages.slice(0, -1) }];
  } else {
    const reply = messages.findLastIndex((m) => m.role === "assistant");
    // The turn's prompt is the caller's, not looked for in `messages`: in a turn already shortened once, the last user
    // message there without results is that shortening's new history, which would be kept again, nesting deeper each time.
    prompt = s.asked?.parts;
    options = [{ part: messages.slice(0, reply), round: roundText(messages[reply]!, messages[reply + 1]) }, { part: messages }];
  }
  try {
    // What is kept is checked alone first, so no summary is paid for that could not be used: a prompt that does not fit on
    // its own ends the shortening, and a round that does not fit with it goes into the summary from the start.
    if (prompt && !(await fit(s, newHistory({ prompt })))) return { problem: PROMPT_TOO_BIG };
    // Only the first option can be empty: the second, during a turn, is the whole history.
    if (!options[0]!.part.length) return { problem: NOTHING };
    if (options[0]!.round !== undefined && !(await fit(s, newHistory({ prompt, round: options[0]!.round })))) options.shift();
    const files = await recentFiles(s);
    for (const { part, round } of options) {
      const summary = await summarise(s, part);
      // The summary must fit the space the next request has, and is checked before it is used (design, "Carried over").
      const message = newHistory({ summary, prompt, round, files });
      if (await fit(s, message)) return { messages: [message], summary };
    }
    return { problem: STILL_TOO_BIG };
  } catch (err) {
    if (err instanceof Problem) return { problem: err.message };
    if (s.signal?.aborted) return { problem: CANCELLED }; // fits() lets a stop through
    throw err;
  }
}

// Whether the new history, sent with the conversation's system prompt and tools, fits the window. No way to tell
// (null: no ratio yet and no exact count) counts as fitting, as a request with no advance check is sent and the "too
// long" safety net covers it (design, "When to shorten"). The session checks the new history again with a SessionStart
// hook's text in it (release 8b plan, Task 11).
export async function fit(s: Shortening, message: Message): Promise<boolean> {
  return (await fits(s.lead, { ...pictures(s), system: s.system, messages: [message], tools: s.tools, signal: s.signal }, s.sizes, s.window)) !== false;
}

// The session's pictures, as each request carries them.
const pictures = (s: Shortening) => ({ ...(s.shrunk ? { shrunk: s.shrunk } : {}), ...(s.refusedBy ? { refusedBy: s.refusedBy } : {}) });

// One summary of `part`, in pieces only when needed (choice 23): the whole part first; if the lead says it is too long,
// or the summary is cut off at the window or the output limit, the two halves either side of the message nearest its
// middle, never between a call and its results (middle()), each the same way, then their summaries summarised together
// with the same instructions. `later`: this piece does not start where the whole part does, so it is sent as
// laterPiece() makes it, and so are both its halves.
async function summarise(s: Shortening, part: Message[], later = false): Promise<string> {
  const whole = await ask(s, later ? laterPiece(part) : part);
  if (whole !== undefined) return whole;
  const at = middle(part);
  if (at === undefined) throw new Problem(ONE_EXCHANGE);
  const first = await summarise(s, part.slice(0, at), later);
  const second = await summarise(s, part.slice(at), true);
  const both = await ask(s, [{ role: "user", parts: [{ type: "text", text: `${first}\n\n${second}` }] }]);
  if (both === undefined) throw new Problem(COMBINED_TOO_LONG);
  return both;
}

// One summary request: the part, then the instructions as the user's, joining the part's last message when that is the
// user's, so the roles still take turns (step 3). It carries the conversation's own system prompt and tools: Anthropic
// refuses a call or a result in a request that defines no tools, and the same start keeps the prompt cache. Its usage
// is reported as soon as it ends, as Session#request reports a request's, the declined attempts first; a request that
// throws has none to report, so nothing is made up for it. Undefined: too long, or cut off, so the part is split.
async function ask(s: Shortening, part: Message[]): Promise<string | undefined> {
  if (s.signal?.aborted) throw new Problem(CANCELLED);
  const words: Part = { type: "text", text: s.focus ? `${INSTRUCTIONS}\n\nFocus on: ${s.focus}` : INSTRUCTIONS };
  const last = part.at(-1);
  const messages: Message[] =
    last?.role === "user" ? [...part.slice(0, -1), { ...last, parts: [...last.parts, words] }] : [...part, { role: "user", parts: [words] }];
  let turn;
  try {
    turn = await s.lead.complete({ ...pictures(s), system: s.system, messages: sentAll(messages), tools: s.tools, signal: s.signal });
  } catch (err) {
    if (s.signal?.aborted) throw new Problem(CANCELLED);
    if (s.lead.tooLong?.(err)) return undefined;
    throw new Problem(errorText(err));
  }
  for (const d of turn.declined ?? []) s.onUsage(d);
  s.onUsage({ provider: turn.servedBy ?? s.lead.id, usage: turn.usage });
  if (s.signal?.aborted) throw new Problem(CANCELLED);
  if (turn.cutOff?.kind === "refusal") throw new Problem(turn.cutOff.detail);
  if (turn.cutOff) return undefined;
  const summary = turn.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("").trim();
  if (!summary) throw new Problem(EMPTY_SUMMARY);
  return summary;
}

// A later piece as it is sent: opening with LATER_PART, as its own user message before a reply, or as the first text
// part of a user message, so no two user messages come in a row; and without any message's `native`, so the provider
// rebuilds each reply from its parts: Anthropic refuses a reply's thinking once the conversation before it has changed.
// A results message never opens a piece, as middle() never cuts between calls and their results.
function laterPiece(part: Message[]): Message[] {
  const plain = part.map(({ native: _, ...m }) => m);
  const line: Part = { type: "text", text: LATER_PART };
  const [head, ...rest] = plain;
  if (head?.role === "user") return [{ ...head, parts: [line, ...head.parts] }, ...rest];
  return [{ role: "user", parts: [line] }, ...plain];
}

// Where to split a part: before the message whose start is nearest the middle by characters (choice 16), never between
// a reply's calls and their results, so each half is complete. Undefined for a part of one exchange.
function middle(part: Message[]): number | undefined {
  const sizes = part.map((m) => characters("", [m], []));
  const total = sizes.reduce((a, b) => a + b, 0);
  let best: number | undefined;
  let bestOff = Infinity;
  let before = 0;
  for (let i = 1; i < part.length; i++) {
    before += sizes[i - 1]!;
    const prev = part[i - 1]!;
    if (prev.role === "assistant" && prev.parts.some((p) => p.type === "tool_call")) continue;
    const off = Math.abs(2 * before - total);
    if (off < bestOff) [best, bestOff] = [i, off];
  }
  return best;
}

// The latest round as text: the reply's words, then each call with its result under it as Ctrl+O shows it (callText),
// then any text that came in with the results, so nothing in it is left out.
function roundText(reply: Message, after: Message | undefined): string {
  const results = new Map(after?.parts.flatMap((p) => (p.type === "tool_result" ? [[p.callId, p.output] as const] : [])));
  const lines = reply.parts.flatMap((p) => (p.type === "text" ? [p.text] : p.type === "tool_call" ? [callText(p, results.get(p.id))] : []));
  return [...lines, ...(after?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) ?? [])].join("\n");
}

// The new history's one message, in the approved layout (plan, "The new history's message"), each part only when it has
// something in it. The prompt goes in as its parts, so its pictures are kept; its text and the layout's are one text
// part where they meet, and a note the session added for the lead (`from: "tasks"`) stays its own.
function newHistory(k: { summary?: string; prompt?: Part[]; round?: string; files?: string }): Message {
  const parts: Part[] = [];
  const put = (p: Part) => {
    const last = parts.at(-1);
    if (p.type === "text" && p.from === undefined && last?.type === "text" && last.from === undefined) last.text += p.text;
    else parts.push({ ...p });
  };
  const sections: (string | Part)[][] = [];
  if (k.summary) sections.push([`This conversation was shortened. A summary of everything before this point:\n\n${k.summary}`]);
  if (k.prompt?.length) sections.push(["The request being worked on, word for word:\n", ...k.prompt]);
  if (k.round) sections.push([`The latest round of tool calls, and their results:\n${k.round}`]);
  if (k.files) sections.push([`The files read or edited in this session, as they are now:\n${k.files}`]);
  for (const [i, section] of sections.entries()) {
    if (i) put({ type: "text", text: "\n\n" });
    for (const x of section) put(typeof x === "string" ? { type: "text", text: x } : x);
  }
  return { role: "user", parts };
}

// The files read or edited in this session (choice 22): the `path` of each read_file, write_file and edit_file call,
// the most recent call first, each file once and 5 at most, a file outside the project skipped and not counted. Each is
// read as it is now; one over 5,000 tokens by the lead's ratio, or of a size not known as the lead has no ratio yet, is
// named without its content, and so is one that cannot be read (user, 2026-11-06, option chosen: "Two short notes").
// A path the file tools refuse (resolve throws: the data folder, a settings file) cannot be read, so it is named so.
async function recentFiles(s: Shortening): Promise<string | undefined> {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (let i = s.calls.length - 1; i >= 0 && lines.length < FILES; i--) {
    const { name, input } = s.calls[i]!;
    const p: unknown = (input as { path?: unknown } | null)?.path;
    if (!FILE_TOOLS.has(name) || typeof p !== "string") continue;
    let place;
    try {
      place = await s.workspace.resolve(p);
    } catch {
      if (!seen.has(p)) lines.push(`--- ${p} (could not be read) ---`);
      seen.add(p);
      continue;
    }
    const key = place.real ?? place.abs; // "a.txt" and "./a.txt" are one file
    if (place.outside || seen.has(key)) continue;
    seen.add(key);
    let text;
    try {
      text = await s.workspace.readText(place.abs);
    } catch {
      lines.push(`--- ${p} (could not be read) ---`);
      continue;
    }
    // Its characters as a text part's, by choice 16's count.
    const tokens = s.sizes.estimate(s.lead.id, JSON.stringify(text).length);
    if (tokens === null) lines.push(`--- ${p} (size not known yet; read it again if needed) ---`);
    else if (tokens > FILE_TOKENS) lines.push(`--- ${p} (over 5,000 tokens; read it again if needed) ---`);
    else lines.push(`--- ${p} ---\n${text.replace(/\r?\n$/, "")}`);
  }
  return lines.length ? lines.join("\n") : undefined;
}
