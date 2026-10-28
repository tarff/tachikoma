import type { Key } from "ink";

// Every key Tachikoma reacts to is a named action in a context (release 6 design, "Keys become named actions"), written as
// Claude Code's keybindings.json writes them, so a keys file from Claude Code can be read as it is ("The keys file"). The
// syntax, the context names, the action names and the reserved keys are Claude Code's keybindings page's, read 2026-10-28.
export type Context = "Global" | "Chat" | "Autocomplete" | "Confirmation" | "HistorySearch" | "Select" | "Transcript" | "Scroll";
export const CONTEXTS: Context[] = ["Global", "Chat", "Autocomplete", "Confirmation", "HistorySearch", "Select", "Transcript", "Scroll"];

// One keystroke. `key` is a lower-case character or a special key's name ("enter", "pageup", "wheelup"); a capital letter is
// its letter with Shift, as Claude Code reads keys case-insensitively and writes Shift out ("shift+n").
export interface Stroke {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

// Between one stroke of a chord and the next: Claude Code's keybindings page, "Chords" ("within 3 seconds").
const CHORD_MS = 3000;

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift"> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  meta: "alt",
  shift: "shift",
};
// Claude Code's Command or Super key: no stroke here has it, as Ink tells it only through the kitty protocol, which the user's
// terminal lacks (release 6 probe).
const SUPER = new Set(["cmd", "command", "super", "win"]);
const SPECIAL: Record<string, string> = {
  escape: "escape",
  esc: "escape",
  enter: "enter",
  return: "enter",
  ...Object.fromEntries(
    ["tab", "space", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "backspace", "delete", "wheelup", "wheeldown"].map((n) => [n, n]),
  ),
};

// A key as written in a keys file: modifiers and a key joined by "+", a chord's strokes by spaces.
export function parseKeys(text: string): Stroke[] | { problem: string } {
  // Claude Code would read "ctrl+ k" as a chord that never fires; saying so is kinder (its page, "Validation").
  if (/\s\+|\+\s/.test(text)) return { problem: 'a space beside "+"' };
  const strokes: Stroke[] = [];
  for (const part of text.trim().split(/\s+/)) {
    const names = part.split("+");
    const name = names.pop()!.toLowerCase();
    const stroke: Stroke = { key: SPECIAL[name] ?? name, ctrl: false, alt: false, shift: false };
    for (const m of names) {
      if (SUPER.has(m.toLowerCase())) return { problem: `Tachikoma has no "${m}" modifier` };
      const mod = MODIFIERS[m.toLowerCase()];
      if (!mod) return { problem: `unknown modifier "${m}"` };
      stroke[mod] = true;
    }
    if (!SPECIAL[name] && [...name].length !== 1) return { problem: `unknown key "${name}"` };
    strokes.push(stroke);
  }
  return strokes;
}

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
// keystroke: typed text read together, a paste, a control character with no name. Ink names a held Ctrl or Alt key by its
// letter, Alt as `meta` (the probe's Alt+V, ESC v, comes as "v" with meta), and a capital with Shift. The wheel comes from
// the mouse reports (input.ts), not from here.
export function strokeOf(input: string, key: Key): Stroke | null {
  const named = NAMED.find(([flag]) => key[flag])?.[1];
  if (named) return { key: named, ctrl: key.ctrl, alt: key.meta, shift: key.shift };
  const chars = [...input];
  if (chars.length !== 1) return null;
  const c = chars[0]!;
  // Ink reports a line feed with no flag: it is Ctrl+J (keys.ts). Ctrl+\ to Ctrl+_ come as 0x1c to 0x1f with no flag,
  // the character 0x40 above (Ctrl+_ is 0x1f).
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
export const tableOf = (file: Record<Context, Record<string, string | null>>): Record<Context, Map<string, string | null>> =>
  Object.fromEntries(CONTEXTS.map((c) => [c, new Map(Object.entries(file[c]))])) as Record<Context, Map<string, string | null>>;

export class Bindings {
  readonly #table: Record<Context, Map<string, string | null>>;
  #chord: { strokes: Stroke[]; at: number } | null = null;

  // Each key is kept in keyText's spelling, so "Ctrl+G" in a keys file is the default's "ctrl+g". The keys file's reader
  // reports a key parseKeys cannot read before it builds a table, so one here is a mistake in the code.
  constructor(table: Record<Context, Map<string, string | null>>) {
    this.#table = Object.fromEntries(
      CONTEXTS.map((c) => {
        const keys = [...table[c]].map(([text, action]): [string, string | null] => {
          const strokes = parseKeys(text);
          if (!Array.isArray(strokes)) throw new Error(`${c} "${text}": ${strokes.problem}`);
          return [keyText(strokes), action];
        });
        return [c, new Map(keys)];
      }),
    ) as Record<Context, Map<string, string | null>>;
  }

  // The action for this stroke in the contexts in force (innermost first), a chord under way, or nothing. As in Claude
  // Code (its page, "Unbind default shortcuts"), a stroke that begins a chord in any context in force waits for the next,
  // over a single-key binding of the same stroke. A key set to null binds nothing in its context, and the outer contexts
  // are looked in. A stroke that does not complete the chord waiting drops it and gives null, the stroke unread, so the
  // caller handles it as if no chord had waited, asking again where its own rules reach the bindings (plan, Task 6: a
  // letter goes into a search field before any binding). A chord dropped after 3 s leaves this stroke read as a first.
  press(stroke: Stroke, contexts: Context[], now: number): { action: string } | { pending: Stroke[] } | null {
    const before = this.waiting(now);
    this.#chord = null;
    const strokes = [...(before ?? []), stroke];
    const text = keyText(strokes);
    const tables = contexts.map((c) => this.#table[c]);
    if (tables.some((t) => [...t].some(([k, action]) => action !== null && k.startsWith(`${text} `)))) {
      this.#chord = { strokes, at: now };
      return { pending: strokes };
    }
    for (const t of tables) {
      const action = t.get(text);
      if (action) return { action };
    }
    return null;
  }

  // The strokes of a chord under way, for the hint row (release 6 design, "The keys file"), or null.
  waiting(now: number): Stroke[] | null {
    return this.#chord && now - this.#chord.at <= CHORD_MS ? this.#chord.strokes : null;
  }

  // The keys bound to an action in a context, in the table's order, for help and hints.
  keysFor(action: string, context: Context): string[] {
    return [...this.#table[context]].filter(([, a]) => a === action).map(([k]) => k);
  }
}
