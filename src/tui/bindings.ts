import type { Key } from "ink";

// Every key Tachikoma reacts to is a named action in a context (release 6 design, "Keys become named actions"), written as
// Claude Code's keybindings.json writes them, so a keys file from Claude Code can be read as it is ("The keys file"). The
// syntax, the context names, the action names and the reserved keys are Claude Code's keybindings page's, read 2026-10-28.
export const CONTEXTS = ["Global", "Chat", "Autocomplete", "Confirmation", "HistorySearch", "Select", "Transcript", "Scroll"] as const;
export type Context = (typeof CONTEXTS)[number];

// One keystroke. `key` is a lower-case character or a special key's name ("enter", "pageup", "wheelup"); a capital letter is
// its letter with Shift, as Claude Code reads keys case-insensitively and writes Shift out ("shift+n").
export interface Stroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

// Each context's keys, in keyText's spelling, to an action, or to null where the keys file unbinds one.
type Table = Record<Context, Map<string, string | null>>;

// Between one stroke of a chord and the next: Claude Code's keybindings page, "Chords" ("within 3 seconds"). The window ends
// at the 3000 ms mark, so a timer of this length set at a stroke finds the chord gone (Task 6's hint row).
export const CHORD_MS = 3000;

const MODIFIERS = new Map<string, "ctrl" | "alt" | "shift">([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["opt", "alt"],
  ["option", "alt"],
  ["meta", "alt"],
  ["shift", "shift"],
]);
// Claude Code's Command or Super key. Ink reports it only through the kitty protocol, which cli.tsx asks for where the
// terminal has it; a stroke here has no Super, so a keys file cannot name it and strokeOf makes nothing of a key held with it.
// The keys file's reader counts a key with one among those Tachikoma has no use for (keybindings.ts).
export const SUPER = new Set(["cmd", "command", "super", "win"]);
const SPECIAL = new Map<string, string>([
  ["escape", "escape"],
  ["esc", "escape"],
  ["enter", "enter"],
  ["return", "enter"],
  ...["tab", "space", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "backspace", "delete", "wheelup", "wheeldown"].map(
    (n): [string, string] => [n, n],
  ),
]);

// A key as written in a keys file: modifiers and a key joined by "+", a chord's strokes by spaces.
export function parseKeys(text: string): Stroke[] | { problem: string } {
  if (!text.trim()) return { problem: "no key" };
  // Claude Code would read "ctrl+ k" as a chord that never fires; saying so is kinder (its page, "Validation").
  if (/\s\+|\+\s/.test(text)) return { problem: 'a space beside "+"' };
  const strokes: Stroke[] = [];
  for (const part of text.trim().split(/\s+/)) {
    const names = part.split("+");
    const written = names.pop()!;
    const name = written.toLowerCase();
    if (!name) return { problem: 'a "+" with no key after it' };
    const stroke: Stroke = { key: SPECIAL.get(name) ?? name, ctrl: false, alt: false, shift: false };
    for (const m of names) {
      if (!m) return { problem: 'a "+" with no modifier before it' };
      if (SUPER.has(m.toLowerCase())) return { problem: `Tachikoma has no "${m}" modifier` };
      const mod = MODIFIERS.get(m.toLowerCase());
      if (!mod) return { problem: `unknown modifier "${m}"` };
      stroke[mod] = true;
    }
    if (!SPECIAL.has(name) && [...name].length !== 1) return { problem: `unknown key "${written}"` };
    strokes.push(stroke);
  }
  return strokes;
}

// The slash commands that take nothing after them, which a key bound to `command:<name>` runs (release 6 plan,
// Task 11).
export const KEY_COMMANDS = ["exit", "errors", "model", "screen", "tasks", "vim", "settings", "keybindings"];

// One spelling of a key, the table's and the help's: "ctrl+alt+shift+k", strokes joined by a space.
export const keyText = (strokes: Stroke[]): string =>
  strokes.map((s) => [s.ctrl && "ctrl", s.alt && "alt", s.shift && "shift", s.key].filter(Boolean).join("+")).join(" ");

// The keys Claude Code reserves (its page, "Reserved shortcuts"): Ctrl+C and Ctrl+D, and four that arrive as Enter, Esc,
// Tab and Backspace (release 6 design, "Keys become named actions").
export const RESERVED: Stroke[] = ["c", "d", "m", "[", "i", "h"].map((key) => ({ key, ctrl: true, alt: false, shift: false }));

const NAMED: [keyof Key, string][] = [
  ["upArrow", "up"],
  ["downArrow", "down"],
  ["leftArrow", "left"],
  ["rightArrow", "right"],
  ["pageUp", "pageup"],
  ["pageDown", "pagedown"],
  ["home", "home"],
  ["end", "end"],
  ["return", "enter"],
  ["escape", "escape"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
];

// The stroke for a key from Ink's useInput (Ink 7.1.1's parse-keypress.js and use-input.js), or null for what is not one
// keystroke: typed text read together, a paste, a control character with no name, a key held with Super or Hyper. Ink names
// a held Ctrl or Alt key by its letter, Alt as `meta` (the probe's Alt+V, ESC v, comes as "v" with meta), and a capital
// with Shift. The wheel comes from the mouse reports (input.ts), not from here.
// Where the terminal has the kitty protocol, two keys come differently, and are left as Ink gives them: Ctrl+Space is
// "ctrl+space" there and "ctrl+`" elsewhere (a NUL, which Ink names by the character 0x60 above it), and Ctrl+_ is
// "ctrl+shift+-" there, so chat:undo's Ctrl+_ does not fire under kitty, while its Ctrl+Z does.
export function strokeOf(input: string, key: Key): Stroke | null {
  if (key.super || key.hyper) return null;
  const named = NAMED.find(([flag]) => key[flag])?.[1];
  if (named) return { key: named, ctrl: key.ctrl, alt: key.meta, shift: key.shift };
  const chars = [...input];
  if (chars.length !== 1) return null;
  const c = chars[0]!;
  // Ink reports a line feed with no flag: it is Ctrl+J (keys.ts). Ctrl+\ to Ctrl+_ come with no flag too, each as its
  // character less 0x40: 0x1c is Ctrl+\, 0x1f is Ctrl+_.
  if (c === "\n") return { key: "j", ctrl: true, alt: key.meta, shift: false };
  const code = c.codePointAt(0)!;
  if (code >= 0x1c && code <= 0x1f) return { key: String.fromCodePoint(code + 0x40), ctrl: true, alt: key.meta, shift: false };
  if (/\p{Cc}/u.test(c)) return null;
  return { key: c === " " ? "space" : c.toLowerCase(), ctrl: key.ctrl, alt: key.meta, shift: key.shift };
}

// The default table, in Claude Code's file shape (keys to action, a block a context): today's keys under Claude Code's names
// where it has the action, and Tachikoma's own named in its style (plan, Task 5). Each action's first key is the one hints
// name. Picture pasting is Alt+V on Windows, where Ctrl+V never reaches the program (the terminal pastes; release 6 probe),
// both on WSL, Alt+V first, since it runs in the same Windows terminals, and Ctrl+V elsewhere, as Claude Code has them (its
// keybindings page: "On WSL, both shortcuts are bound by default").
export function defaultsFor(platform: NodeJS.Platform, wsl: boolean): Record<Context, Record<string, string>> {
  const paste = platform === "win32" ? ["alt+v"] : wsl ? ["alt+v", "ctrl+v"] : ["ctrl+v"];
  return {
    Global: { "ctrl+c": "app:interrupt", "ctrl+d": "app:exit", "ctrl+t": "app:toggleTodos", "ctrl+o": "app:toggleTranscript" },
    Chat: {
      enter: "chat:submit",
      "shift+enter": "chat:newline",
      "ctrl+j": "chat:newline",
      "shift+tab": "chat:cycleMode",
      "alt+p": "chat:modelPicker",
      "ctrl+z": "chat:undo",
      "ctrl+_": "chat:undo",
      escape: "chat:cancel",
      "ctrl+r": "history:search",
      up: "history:previous",
      "ctrl+p": "history:previous", // release 3's history keys; Claude Code puts Ctrl+P and Ctrl+N on Select
      down: "history:next",
      "ctrl+n": "history:next",
      "ctrl+g": "chat:externalEditor",
      "ctrl+x ctrl+e": "chat:externalEditor",
      "ctrl+s": "chat:stash",
      ...Object.fromEntries(paste.map((k) => [k, "chat:imagePaste"])),
    },
    Autocomplete: { tab: "autocomplete:accept", escape: "autocomplete:dismiss", up: "autocomplete:previous", down: "autocomplete:next" },
    Confirmation: { y: "confirm:yes", n: "confirm:no", escape: "confirm:no" },
    HistorySearch: {
      "ctrl+r": "historySearch:next",
      escape: "historySearch:accept",
      tab: "historySearch:accept",
      "ctrl+c": "historySearch:cancel",
      enter: "historySearch:execute",
    },
    Select: { down: "select:next", up: "select:previous", enter: "select:accept", escape: "select:cancel" },
    Transcript: {
      q: "transcript:exit",
      "ctrl+c": "transcript:exit",
      escape: "transcript:exit",
      "[": "transcript:print",
      "/": "transcript:search",
      n: "transcript:nextMatch",
      "shift+n": "transcript:previousMatch",
      j: "transcript:lineDown",
      down: "transcript:lineDown",
      k: "transcript:lineUp",
      up: "transcript:lineUp",
      g: "transcript:top",
      home: "transcript:top",
      "shift+g": "transcript:bottom",
      end: "transcript:bottom",
    },
    Scroll: {
      pageup: "scroll:pageUp",
      pagedown: "scroll:pageDown",
      "ctrl+home": "scroll:top",
      "ctrl+end": "scroll:bottom",
      "shift+up": "scroll:lineUp",
      wheelup: "scroll:lineUp",
      "shift+down": "scroll:lineDown",
      wheeldown: "scroll:lineDown",
    },
  };
}
// WSL sets WSL_DISTRO_NAME inside every distribution it runs (the coordinator's spec review of Task 5, 2026-10-28; Microsoft's
// "Working across file systems" page, read the same day, does not name it). The only place the platform is read.
export const DEFAULTS = defaultsFor(process.platform, process.env.WSL_DISTRO_NAME !== undefined);

// A table for Bindings from a file-shaped one, which the keys file (Task 11) then lays its entries over.
export const tableOf = (file: Record<Context, Record<string, string | null>>): Table =>
  Object.fromEntries(CONTEXTS.map((c) => [c, new Map(Object.entries(file[c]))])) as Table;

const copy = (strokes: Stroke[]): Stroke[] => strokes.map((s) => ({ ...s }));

export class Bindings {
  readonly #table: Table;
  #chord: { strokes: Stroke[]; at: number } | null = null;

  // Each key is kept in keyText's spelling, so "Ctrl+G" in a keys file is the default's "ctrl+g"; of two spellings of one
  // key, the later's action stands in the earlier's place. The keys file's reader reports a key parseKeys cannot read
  // before it builds a table, so one here is a mistake in the code.
  constructor(table: Table) {
    this.#table = Object.fromEntries(
      CONTEXTS.map((c) => {
        const keys = [...table[c]].map(([text, action]): [string, string | null] => {
          const strokes = parseKeys(text);
          if (!Array.isArray(strokes)) throw new Error(`${c} "${text}": ${strokes.problem}`);
          return [keyText(strokes), action];
        });
        return [c, new Map(keys)];
      }),
    ) as Table;
  }

  // The action for this stroke in the contexts in force (innermost first), a chord under way, or nothing. As in Claude
  // Code (its page, "Unbind default shortcuts"), a stroke that begins a chord in any context in force waits for the next,
  // over a single-key binding of the same stroke; a chord set to null frees its prefix in that context, and the prefix is
  // a single key again once every chord on it is. A key set to null does nothing in its context, even where an outer
  // context binds it (choice 18, the user's, 2026-10-28): the lookup stops there. A stroke that does not complete the
  // chord waiting drops it and gives null, the stroke unread, so the caller handles it as if no chord had waited, asking
  // again where its own rules reach the bindings (plan, Task 6: a letter goes into a search field before any binding).
  // So null means either no binding or a dropped chord, and a caller that must tell them apart asks waiting(now) first. A
  // chord dropped after 3 s leaves this stroke read as a first.
  press(stroke: Stroke, contexts: Context[], now: number): { action: string } | { pending: Stroke[] } | null {
    const before = this.waiting(now);
    this.#chord = null;
    const strokes = [...(before ?? []), stroke];
    const text = keyText(strokes);
    const tables = this.#tables(contexts);
    if (this.#begins(tables, text)) {
      this.#chord = { strokes, at: now };
      return { pending: copy(strokes) };
    }
    const action = this.#bound(tables, text);
    return action ? { action } : null;
  }

  #tables(contexts: Context[]): Map<string, string | null>[] {
    return contexts.map((c) => this.#table[c]);
  }

  // The innermost binding of a key in `tables`: an action, null where a context unbinds it (the lookup stops there,
  // choice 18), or undefined where no context has it.
  #bound(tables: Map<string, string | null>[], text: string): string | null | undefined {
    for (const t of tables) {
      const action = t.get(text);
      if (action !== undefined) return action;
    }
    return undefined;
  }

  // Whether a chord starts with this key and binds an action where it counts: in the innermost context that has the
  // chord (choice 18).
  #begins(tables: Map<string, string | null>[], text: string): boolean {
    return tables.some((t) => [...t.keys()].some((k) => k.startsWith(`${text} `) && this.#bound(tables, k) != null));
  }

  // Drops a chord under way, for what is no one keystroke and so can complete none: text read together (App.tsx,
  // route).
  drop(): void {
    this.#chord = null;
  }

  // The strokes of a chord under way, for the hint row (release 6 design, "The keys file"), or null.
  waiting(now: number): Stroke[] | null {
    return this.#chord && now - this.#chord.at < CHORD_MS ? copy(this.#chord.strokes) : null;
  }

  // Whether a key, in keyText's spelling, is taken in the contexts in force (innermost first), as press takes it:
  // bound to an action, or the first key of a chord bound to one. A key it takes never reaches the prompt's own
  // editing keys, so `?` leaves those out (keys.ts, keyList; release 6 plan, Task 23's spec review).
  takes(text: string, contexts: Context[]): boolean {
    const tables = this.#tables(contexts);
    return this.#bound(tables, text) != null || this.#begins(tables, text);
  }

  // Whether a key, or a chord, in keyText's spelling, runs `action` in the contexts in force, as press runs it: its
  // innermost binding is that action, and no chord bound where it counts starts with it, which press would wait on
  // instead. So `?` lists a key only where it does what the list says (keys.ts, keyList; Task 23's code review).
  acts(text: string, action: string, contexts: Context[]): boolean {
    const tables = this.#tables(contexts);
    return this.#bound(tables, text) === action && !this.#begins(tables, text);
  }

  // The keys bound to an action in a context, in the table's order, for help and hints.
  keysFor(action: string, context: Context): string[] {
    return [...this.#table[context]].filter(([, a]) => a === action).map(([k]) => k);
  }

  // This table, a live edit of the keys file, with every binding that could change how a key answers a permission
  // question put back as `launch` has it, so each key answers yes, no or nothing as at launch, and with whether any was
  // (release 6 plan, choice 30: a shell command could rewrite the file so n answers yes). A question reads Confirmation,
  // then Scroll in full screen, then Global (App.tsx, contextsOf), and press reads only the keys that are, or start
  // with, the strokes read so far, a chord the prompt started included. So Confirmation is kept whole; and in Scroll and
  // Global, every key holding a stroke that begins an answer: a key of launch's Confirmation, or one bound to
  // confirm:yes or confirm:no in launch's or this Scroll or Global. Strokes read that hold none of those can answer
  // nothing, at launch or now; strokes that hold one are read only among keys kept as at launch.
  keepAnswers(launch: Bindings): { table: Bindings; held: boolean } {
    const first = (text: string) => text.split(" ")[0]!;
    const answers = (t: Table) =>
      (["Scroll", "Global"] as const).flatMap((c) => [...t[c]].filter(([, a]) => a === "confirm:yes" || a === "confirm:no").map(([text]) => first(text)));
    const starts = new Set([...[...launch.#table.Confirmation.keys()].map(first), ...answers(launch.#table), ...answers(this.#table)]);
    const table: Table = { ...this.#table, Confirmation: new Map(launch.#table.Confirmation) };
    for (const c of ["Scroll", "Global"] as const) {
      const keys = new Map(this.#table[c]);
      for (const text of new Set([...keys.keys(), ...launch.#table[c].keys()])) {
        if (!text.split(" ").some((s) => starts.has(s))) continue;
        if (launch.#table[c].has(text)) keys.set(text, launch.#table[c].get(text) as string | null);
        else keys.delete(text);
      }
      table[c] = keys;
    }
    const same = (a: Map<string, string | null>, b: Map<string, string | null>) => a.size === b.size && [...a].every(([text, action]) => b.has(text) && b.get(text) === action);
    const held = CONTEXTS.some((c) => !same(table[c], this.#table[c]));
    return { table: held ? new Bindings(table) : this, held };
  }
}
