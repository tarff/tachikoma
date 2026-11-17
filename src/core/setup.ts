// The date and the setup the model is told of (system prompt plan; design, "Notes to the model").

import { shellFor } from "../exec/local.js";
import { gitLine } from "./prompt.js";
import type { Git, Part, Setup } from "./types.js";

// The local date as YYYY-MM-DD (design, "The date"), for the prompt's date line and the date note.
export const localDate = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// What a saved line says of the setup: a Setup, or, on a line written before the setup was recorded, its `box` alone
// (design, "Sessions saved before this change"): "off", with git not known, or "on", with the sandbox's kind, network
// and git not known.
export type Known = Setup | { sandbox: "off" | "on" };
// What the model was told (design, "What the model was told"): the date, if it was ever told one, and the setup.
export interface Told {
  date?: string;
  setup: Known;
}

const GITS: readonly unknown[] = ["repo", "none", "outside", "copy"] satisfies Git[];

// A setup as a saved line or note holds it: a known git and "off", or "live" or "copy" with a network of "on" or "off"
// (extra keys are not checked, as nothing reads them), so a damaged value tells nothing.
export function isSetup(v: unknown): v is Setup {
  const s = (v ?? {}) as Record<string, unknown>;
  if (!GITS.includes(s.git)) return false;
  return (
    s.sandbox === "off" ||
    ((s.sandbox === "live" || s.sandbox === "copy") && (s.network === "on" || s.network === "off"))
  );
}

// The same setup: the sandbox setting and, in the box, its network (design, "Another setup"); git is not compared
// (system prompt plan, decision 12).
export function sameSetup(a: Known, b: Setup): boolean {
  if (a.sandbox !== b.sandbox) return false;
  return b.sandbox === "off" || ("network" in a && a.network === b.network);
}

// Whether shell commands can reach the web: with no sandbox they can (design, item 4); undefined when not known.
const reaches = (s: Known): boolean | undefined =>
  s.sandbox === "off" ? true : "network" in s ? s.network === "on" : undefined;

// The setup note (design, "Another setup"; the user's words, 2026-11-17), or undefined for the same setup: a sentence
// for each fact that differs, in the design's order, between its opening and closing ones. An earlier fact not known
// (`box` alone) is said without its "earlier" half, and the note closes only when a known fact differs. Such a session
// resumed in the sandbox opens saying its earlier sandbox setup was not recorded (Task 3's code review; the user's
// choice). `host` is the project folder as typed and the host's platform, whose shell the shell line names (choice 1);
// /work and bash are the box's (clilib.ts, BOX_ROOT; release 7 plan, choice 19). Reworded after the Task 10 terminal
// check (the user's choice).
export function setupNote(
  before: Known,
  now: Setup,
  host: { root: string; platform: NodeJS.Platform },
): string | undefined {
  if (sameSetup(before, now)) return undefined;
  const shell = shellFor(host.platform).name;
  const said: string[] = [];
  let known = false;
  if ((before.sandbox === "off") !== (now.sandbox === "off")) {
    known = true;
    said.push(
      now.sandbox === "off"
        ? `Commands now run with ${shell} in ${host.root}; earlier they ran with bash in /work.`
        : `Commands now run with bash in /work; earlier they ran with ${shell} in ${host.root}.`,
    );
  }
  if (now.sandbox !== "off" && before.sandbox !== now.sandbox) {
    if (before.sandbox !== "on") known = true;
    said.push(
      now.sandbox === "copy"
        ? "The sandbox is now a copy of the project."
        : "The sandbox is now a live link to the project.",
    );
  }
  const git = "git" in before ? before.git : undefined;
  if (git !== now.git) {
    if (git !== undefined) known = true;
    said.push(gitLine(now.git));
  }
  const was = reaches(before);
  const is = reaches(now) === true;
  if (was === undefined) {
    said.push(is ? "Shell commands can reach the web now." : "Shell commands cannot reach the web now.");
  } else if (was !== is) {
    known = true;
    said.push(
      is
        ? "Shell commands can reach the web now; earlier they could not."
        : "Shell commands cannot reach the web now; earlier they could.",
    );
  }
  const close = known
    ? ["Earlier replies about the setup were right under the system prompt they were made with."]
    : [];
  const open =
    before.sandbox === "on" && now.sandbox !== "off"
      ? "This note is from Tachikoma, not the user: this session was resumed, its earlier sandbox setup was not " +
        "recorded, and the system prompt was replaced with one for this setup."
      : "This note is from Tachikoma, not the user: this session was resumed under another setup, and the system " +
        "prompt was replaced with one for this setup.";
  return [open, ...said, ...close].join(" ");
}

// The notes due for the next user message (design, "Notes to the model"): the date note when today differs from the
// date last told, or none was, then the setup note when the setup differs; each a part tagged "note", holding what it
// tells, so a saved message records what the model was told (toldAfter). The date note reworded after the Task 10
// terminal check (the user's choice).
export function dueNotes(
  told: Told,
  now: Setup,
  today: string,
  host: { root: string; platform: NodeJS.Platform },
): Part[] {
  const notes: Part[] = [];
  if (told.date !== today) {
    const said = `This note is from Tachikoma, not the user: today's date is now ${today}.`;
    notes.push({ type: "text", text: said, from: "note", note: { date: today } });
  }
  const text = setupNote(told.setup, now, host);
  if (text) notes.push({ type: "text", text, from: "note", note: { setup: now } });
  return notes;
}

// What the model was told once a message's parts are saved: each note's date or setup, the last of each kind winning.
// Read from saved lines too (transcript.ts), so anything else, or a damaged note, tells nothing.
export function toldAfter(told: Told, parts: readonly object[]): Told {
  let { date, setup } = told;
  for (const p of parts as { from?: unknown; note?: { date?: unknown; setup?: unknown } }[]) {
    if (p.from !== "note" || typeof p.note !== "object" || p.note === null) continue;
    if (typeof p.note.date === "string") date = p.note.date;
    if (isSetup(p.note.setup)) setup = p.note.setup;
  }
  return date === undefined ? { setup } : { date, setup };
}

// A date note, which a shortening leaves out of what it copies, as the new prompt has today's date (design, third
// review, finding 1; system prompt plan, decision 8).
export const isDateNote = (p: Part): boolean =>
  p.type === "text" && p.from === "note" && typeof p.note === "object" && p.note !== null && "date" in p.note;

// A setup note, which a shortening carries into its summary request (system prompt plan, decision 13).
export const isSetupNote = (p: Part): boolean =>
  p.type === "text" && p.from === "note" && typeof p.note === "object" && p.note !== null && "setup" in p.note;
