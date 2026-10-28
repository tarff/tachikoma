import type { Key } from "ink";
import { type Bindings, type Context, KEY_COMMANDS, parseKeys, type Stroke, strokeOf } from "./bindings.js";
import { type Action, segmenter } from "./editor.js";

// What a key means in the prompt (release 3 design, "Editing" and "Multi-line"), for the codes the
// user's terminal was seen to send on 2026-10-25. Enter sends; Up and Down move by screen row, which
// needs the screen's width, so App does them, and the rest of these App's own: Ctrl+R's search,
// Shift+Tab's permission mode, Alt+P's model list and Ctrl+O's last turn ("Menus and modes"), and
// Ctrl+T's to-do list (release 4 design, "On screen"); and scrolling the conversation (release 5 design, "Scrolling").
// The keys for all but the editor's own come from the table of actions (bindings.ts; App.tsx, ACTIONS).
export type Command = Action | "submit" | "up" | "down" | "search" | "mode" | "models" | "lastTurn" | "todos" | Scroll;
export type Scroll = "pageUp" | "pageDown" | "top" | "bottom" | "lineUp" | "lineDown";
const SCROLLS = new Set<Command>(["pageUp", "pageDown", "top", "bottom", "lineUp", "lineDown"]);
export const isScroll = (c: Command): c is Scroll => SCROLLS.has(c);

// Ink names a key held with Ctrl or Alt by its letter.
const CTRL: Record<string, Command> = { a: "home", e: "end", w: "deleteToSpace", k: "deleteToEnd", u: "deleteToStart", y: "yank" };
const ALT: Record<string, Command> = { b: "wordLeft", f: "wordRight", d: "deleteWordAfter" };

// How help and hints spell a key: "Ctrl+R", "Shift+↑", "PgUp", a letter alone as typed ("q", "G").
const SPELLED: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  backspace: "Backspace",
  delete: "Delete",
  wheelup: "Wheel up",
  wheeldown: "Wheel down",
};
const spelled = (text: string) =>
  (parseKeys(text) as Stroke[])
    .map((s) =>
      !s.ctrl && !s.alt && [...s.key].length === 1
        ? s.shift
          ? s.key.toUpperCase()
          : s.key
        : [s.ctrl && "Ctrl", s.alt && "Alt", s.shift && "Shift", SPELLED[s.key] ?? s.key.toUpperCase()].filter(Boolean).join("+"),
    )
    .join(" ");

// The keys a hint or help names for an action: each of `usual`, the keys release 5's words name, still bound to it, or
// with none of them, its first key bound, or none, so the words stay release 5's with the default table and a rebind
// never leaves them stale (plan, Task 6, test 1: the same words). Given the contexts in force, only keys that run the
// action there count (Bindings.acts).
export function named(b: Bindings, action: string, context: Context, usual: string[], contexts?: Context[]): string[] {
  const bound = b.keysFor(action, context).filter((k) => !contexts || b.acts(k, action, contexts));
  const kept = usual.filter((k) => bound.includes(k));
  return (kept.length ? kept : bound.slice(0, 1)).map(spelled);
}

// Two keys named side by side, as hints name a pair: "↑↓" for one-character names, "Ctrl+P Ctrl+N" otherwise; either
// may be missing, and with neither, undefined.
export function both(a: string | undefined, b: string | undefined): string | undefined {
  const keys = [a, b].filter((k) => k !== undefined);
  return keys.length ? keys.join(keys.every((k) => [...k].length === 1) ? "" : " ") : undefined;
}

// "a", "a or b", "a, b, or c".
const either = (items: string[]) => (items.length < 3 ? items.join(" or ") : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`);

// What `?` on an empty prompt prints, grey, in the scrollback: the editor's own keys that no binding in `prompt`, the
// contexts the prompt obeys (App.tsx, contextsOf: Scroll too in full screen), takes, the rest from the table. Ctrl-C and
// Ctrl-D are reserved (bindings.ts, RESERVED), so they are written as release 5 wrote them. With `vimFirst`, vim takes
// a plain Esc first, as in INSERT (App.tsx, route), so the first Esc only goes to NORMAL (choice 31).
export function keyList(b: Bindings, prompt: Context[] = ["Chat", "Global"], vimFirst = false): string[] {
  // A key is named only where it runs its action at the prompt; Scroll's as full screen's prompt runs them, Chat, Scroll
  // and Global (App.tsx, contextsOf), as the list names them "(full screen)".
  const fullScreen: Context[] = prompt.includes("Scroll") ? prompt : [...prompt.slice(0, -1), "Scroll", ...prompt.slice(-1)];
  const k = (action: string, context: Context, ...usual: string[]) => named(b, action, context, usual, context === "Scroll" ? fullScreen : prompt);
  const scroll = (action: string, usual: string) => k(`scroll:${action}`, "Scroll", usual)[0];
  // Every key that runs an action at the prompt, from each context the prompt obeys: release 6's keys and the command keys.
  const all = (action: string) => [...new Set(prompt.flatMap((c) => b.keysFor(action, c)))].filter((key) => b.acts(key, action, prompt)).map(spelled);
  // The prompt's own editing keys that still edit: a key a binding in force at the prompt takes acts there instead
  // (design, "Bindings come first").
  const free = (text: string) => (b.takes(text, prompt) ? undefined : spelled(text));
  const killEnd = free("ctrl+k");
  const killStart = free("ctrl+u");
  const killBack = free("ctrl+w");
  const wordBefore = free("alt+backspace");
  // A part of a line: its keys, then what they do, or nothing when no key is bound.
  const part = (keys: (string | undefined)[], words: string, join = (bound: string[]) => bound.join(" ")) => {
    const bound = keys.filter((x) => x !== undefined);
    return bound.length > 0 && `${join(bound)}  ${words}`;
  };
  // Pairs of editing keys, each a first and a second ("Home End"): pairs with both keys free share `together`, and a key
  // left alone by its pair's other being taken gets its own words, so it never claims the other's.
  const paired = (keys: [string, string][], together: string, first: string, second: string) => {
    const whole: string[] = [];
    const firsts: string[] = [];
    const seconds: string[] = [];
    for (const [a, z] of keys) {
      const x = free(a);
      const y = free(z);
      if (x && y) whole.push(`${x} ${y}`);
      else if (x) firsts.push(x);
      else if (y) seconds.push(y);
    }
    const or = (bound: string[]) => bound.join(" or ");
    return [part(whole, together, or), part(firsts, first, or), part(seconds, second, or)];
  };
  // A line of parts, or none when no part has a key, which the list then leaves out.
  const line = (...parts: (string | false)[]) => (parts.some(Boolean) ? `  ${parts.filter(Boolean).join(" · ")}` : null);
  const [submit] = k("chat:submit", "Chat", "enter");
  const [cancel] = k("chat:cancel", "Chat", "escape");
  const toNormal = vimFirst && cancel === spelled("escape") ? `${cancel} ` : ""; // the Esc vim takes first
  const [newline, ...newlines] = k("chat:newline", "Chat", "shift+enter", "ctrl+j");
  const previous = k("history:previous", "Chat", "up", "ctrl+p");
  const next = k("history:next", "Chat", "down", "ctrl+n");
  // "↑ ↓ or Ctrl+P Ctrl+N": each Up key beside its Down key.
  const pairs = Array.from({ length: Math.max(previous.length, next.length) }, (_, i) => [previous[i], next[i]].filter(Boolean).join(" "));
  const list = [
    "Keys:",
    line(part([submit], "send"), part([newline, submit && `\\ then ${submit}`, ...newlines], "new line", either)),
    line(part([cancel && toNormal + cancel], "stop the turn"), part([cancel && `${toNormal}${cancel} ${cancel}`], "clear the prompt")),
    "  Ctrl-C  stop the turn and take back the queue, or clear the prompt · twice when empty  exit",
    "  Ctrl-D twice on an empty prompt  exit",
    line(
      part(pairs, `past prompts${previous[0] ? ` (${previous[0]} takes back a queue)` : ""}`, (bound) => bound.join(" or ")),
      part(k("history:search", "Chat", "ctrl+r"), "search them"),
    ),
    line(
      ...paired(
        [
          ["home", "end"],
          ["ctrl+a", "ctrl+e"],
        ],
        "line start, end",
        "line start",
        "line end",
      ),
      ...paired(
        [
          ["alt+b", "alt+f"],
          ["ctrl+left", "ctrl+right"],
        ],
        "by word",
        "a word left",
        "a word right",
      ),
    ),
    // A key left alone keeps the verb its line's first key gave it.
    line(
      part([killBack], "delete back to a space"),
      part([wordBefore], killBack ? "the word before" : "delete the word before"),
      part([free("alt+d")], killBack || wordBefore ? "the word after" : "delete the word after"),
    ),
    line(
      part([killEnd], "delete to the line's end"),
      part([killStart], killEnd ? "to its start" : "delete to the line's start"),
      part([free("ctrl+y")], killEnd || killStart ? "put it back" : "put back the last delete"),
      part(k("chat:undo", "Chat", "ctrl+z"), "undo"),
    ),
    line(
      "/  commands",
      "@  project paths",
      part(k("chat:cycleMode", "Chat", "shift+tab"), "permission mode"),
      part(k("chat:modelPicker", "Chat", "alt+p"), "pick the model"),
    ),
    line(part(k("app:toggleTranscript", "Global", "ctrl+o"), "the last turn's tool calls in full"), "a space first starts a message with ?"),
    line(part(k("app:toggleTodos", "Global", "ctrl+t"), "show or hide the to-do list")),
    // Release 6's keys have no release 5 words to keep, so each names every key that runs it, as the command keys below
    // do: one the keys file adds shows beside the defaults (release 6 plan, Task 23's checklist, step 3).
    line(part(all("chat:externalEditor"), "open the prompt in your editor", either)),
    line(part(all("chat:stash"), "stash the prompt or bring it back", either), part(all("chat:imagePaste"), "paste a picture", either)),
    // The keys file's command:<name> keys, which run at the prompt (release 6 plan, Task 11), one line a command.
    ...KEY_COMMANDS.map((n) => line(part(all(`command:${n}`), `/${n}`))),
    line(
      part([scroll("pageUp", "pageup"), scroll("pageDown", "pagedown")], "half a screen"),
      part([scroll("top", "ctrl+home"), scroll("bottom", "ctrl+end")], "top, latest"),
      part([scroll("lineUp", "shift+up"), scroll("lineDown", "shift+down")], "a line (full screen)"),
    ),
  ];
  return list.filter((l) => l !== null);
}

export function commands(input: string, key: Key): Command[] {
  // Enter and a line feed alone (Ctrl+J) are chat:submit's and chat:newline's; typed together with text, below, they
  // still send and make a new line.
  if (key.return || input === "\n") return [];
  if (key.leftArrow) return [key.ctrl ? "wordLeft" : "left"];
  if (key.rightArrow) return [key.ctrl ? "wordRight" : "right"];
  if (key.home) return ["home"];
  if (key.end) return ["end"];
  // Backspace, Ctrl+Backspace and Ctrl+H all come as Backspace; Alt+Backspace is told apart.
  if (key.backspace) return [key.meta ? "deleteWord" : "backspace"];
  if (key.delete) return ["delete"];
  if (key.ctrl) return CTRL[input] ? [CTRL[input]] : [];
  if (key.meta) return ALT[input] ? [ALT[input]] : [];
  // Typed text. Keys typed fast enough arrive together, Enter among them: a carriage return sends,
  // a line feed (Ctrl+J) makes a new line, and other control characters are dropped.
  return input.split(/(\r|\n)/).flatMap((part): Command[] => {
    if (part === "\r") return ["submit"];
    if (part === "\n") return ["newline"];
    const text = part.replace(/\p{Cc}/gu, "");
    return text ? [{ type: "insert", text }] : [];
  });
}

// A key as vim mode's `press` takes it (vim.ts; release 6 plan, Task 21): a character typed, as typed, or a key's name
// ("escape", "enter", "left", "tab"...). Null for a key held with Ctrl or Alt, which keeps its table or editor meaning
// (release 6 design, "Vim mode"), and for what is not one key; Esc with Alt is two Escs read together (App.tsx, route).
export function vimKey(input: string, key: Key): string | null {
  const s = strokeOf(input, key);
  if (s?.ctrl || (s?.alt && s.key !== "escape")) return null;
  if (s) return s.key === "space" ? " " : [...s.key].length === 1 ? input : s.key;
  // One character of several code points, which strokeOf takes for text read together.
  return !key.ctrl && !key.meta && pieces(input).length === 1 && !/\p{Cc}/u.test(input) ? input : null;
}

// Typed text read together, a key a piece, for vim mode, where a fast `dw` is two keys (release 6 design, "Vim mode"):
// each character as the screen shows it, Enter (a carriage return) and Ctrl+J (a line feed) apart, and the other
// control characters dropped, as commands() drops them.
export function pieces(input: string): string[] {
  const characters = (part: string) => [...segmenter.segment(part.replace(/\p{Cc}/gu, ""))].map((g) => g.segment);
  return input.split(/(\r|\n)/).flatMap((part) => (part === "\r" || part === "\n" ? [part] : characters(part)));
}
