import { Lexer } from "marked";

// Clickable links (OSC 8): whether the terminal takes them (clickable links plan, Task 1), and the addresses in a text
// (Task 2).

// The terminals Claude Code 2.1.323's own check (`cw`) takes by TERM_PROGRAM or LC_TERMINAL.
const KNOWN = ["ghostty", "Hyper", "kitty", "alacritty", "iTerm.app", "iTerm2", "WarpTerminal"];

// A version as supports-hyperlinks v3.2.0 reads one: a 3-4 digit value with no dots is 0.<first 1-2>.<last 2> (VTE's
// `4601` is 0.46.1); anything else is split at dots, each part parseInt's.
function parseVersion(value = ""): { major: number; minor: number } {
  if (/^\d{3,4}$/.test(value)) {
    const m = /(\d{1,2})(\d{2})/.exec(value) ?? [];
    return { major: 0, minor: parseInt(m[1] ?? "", 10) };
  }
  const parts = value.split(".").map((n) => parseInt(n, 10));
  return { major: parts[0] ?? NaN, minor: parts[1] ?? NaN };
}

// supports-hyperlinks v3.2.0, from its NETLIFY check on, without its command-line flags (plan, decision 1); chalk's
// `level` stands in for its supports-color check. Its TTY check is left out, as hyperlinks() makes it first (plan,
// decision 2), so NETLIFY with output that is not a terminal is no. Only its yes is used: Claude Code's `cw` goes on
// after its no.
function supportsHyperlink(env: NodeJS.ProcessEnv, level: number, platform: NodeJS.Platform): boolean {
  if (env.NETLIFY) return true;
  if (level === 0) return false;
  if ("WT_SESSION" in env) return true;
  if (platform === "win32") return false;
  if (env.CI || env.TEAMCITY_VERSION) return false;
  if (env.TERM_PROGRAM) {
    const version = parseVersion(env.TERM_PROGRAM_VERSION);
    switch (env.TERM_PROGRAM) {
      case "iTerm.app":
        return version.major === 3 ? version.minor >= 1 : version.major > 3;
      case "WezTerm":
        return version.major >= 20200620;
      case "vscode":
        return version.major > 1 || (version.major === 1 && version.minor >= 72);
      case "ghostty":
        return true;
    }
  }
  if (env.VTE_VERSION) {
    if (env.VTE_VERSION === "0.50.0") return false; // supports-hyperlinks: "throws a segfault"
    const version = parseVersion(env.VTE_VERSION);
    return version.major > 0 || version.minor >= 50;
  }
  return env.TERM === "alacritty";
}

// Whether to draw links. FORCE_HYPERLINK as Claude Code 2.1.323 reads it (`t7e`, `ps`): unset or empty decides
// nothing; off when, lower-cased and trimmed, it is 0, false, no or off, or when parseInt gives 0 (`00`, `0abc`); on
// otherwise. Not forced, output that is not a TTY gets none (plan, decision 2). Then supports-hyperlinks' yes, then
// Claude Code's own list (`cw`, its steps after supports-hyperlinks), which still runs on Windows.
export function hyperlinks(env: NodeJS.ProcessEnv, tty: boolean, level: number, platform = process.platform): boolean {
  const forced = env.FORCE_HYPERLINK;
  if (forced) return !(["0", "false", "no", "off"].includes(forced.toLowerCase().trim()) || parseInt(forced, 10) === 0);
  if (!tty) return false;
  if (supportsHyperlink(env, level, platform)) return true;
  const program = env.TERM_PROGRAM;
  if (program && KNOWN.includes(program)) return true;
  if (env.TERMINAL_EMULATOR === "JetBrains-JediTerm") return true;
  if (env.WT_SESSION && program !== "tmux" && !env.TMUX) return true;
  if (program === "tmux") {
    // tmux 3.4 or later, each part parseInt's
    const [major = NaN, minor = NaN] = (env.TERM_PROGRAM_VERSION ?? "").split(".").map((n) => parseInt(n, 10));
    if (major > 3 || (major === 3 && minor >= 4)) return true;
  }
  if (env.LC_TERMINAL && KNOWN.includes(env.LC_TERMINAL)) return true;
  return env.TERM?.includes("kitty") === true;
}

// The address a link opens, from the text as drawn (clickable links plan, Task 2): http:// or https:// in any letter
// case, or www. opened as https:// (decision 3); each character outside 32-126 encoded, as the OSC 8 spec asks; null
// for any other text, for a lone surrogate (which encodeURIComponent throws on), for an address with no host, which
// marked's link rule lets through (`https://`, `https://:80`), and for one over 2083 bytes, the spec's VTE and iTerm2
// limit. The link opens the encoded text itself, not URL's rewrite of it; the // check stays, as URL takes `https:x.y`.
export function target(shown: string): string | null {
  if (!/^https?:\/\//i.test(shown) && !shown.startsWith("www.")) return null;
  let link = "";
  try {
    for (const c of shown.startsWith("www.") ? `https://${shown}` : shown) {
      const code = c.codePointAt(0)!;
      link += code >= 32 && code <= 126 ? c : encodeURIComponent(c);
    }
  } catch {
    return null;
  }
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return null;
  return link.length > 2083 ? null : link; // all of it 32-126 now, so a character a byte
}

// Where marked's GFM address rule could start a token: mailto:, xmpp:, http(s):// or ftp://, www., or an e-mail's name,
// which starts only where a run of name characters starts, so a long run with no @ is read once, not from each of its
// characters (plan, "The design": 40,000 letters 585 ms without it, 0 ms with it).
const START = /mailto:|xmpp:|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|(?<![A-Za-z0-9._+-])[A-Za-z0-9._+-]+@/g;
const { url: URL_RULE, _backpedal: BACKPEDAL } = Lexer.rules.inline.gfm;

// Where an address ends as drawn, though marked's rule runs on (Task 2's code review): `\` starts visible()'s \uXXXX
// escapes (a colour code's ESC) and JSON's own \n; `"` ends a JSON string, as in a tool row's input; `<` and `>` hold
// an <address> in plain text; ` ends inline code written in plain text; ⏎ ␍ ⇥ are visible()'s line break, carriage
// return and a one-line entry's tab. `{}|^` and `]` are left out: `|` is in some real addresses, and the others are
// rare or refused by target().
const STOP = /[\\"<>`⏎␍⇥]/g;

// The web addresses in a text, as marked finds them in a reply's text (plan, "The design"): each whole token marked's
// rule takes, its trailing punctuation dropped as marked's url() drops it unless it is an e-mail, so an e-mail, ftp,
// mailto or xmpp token holds no address (`help@www.example.org`). Only http, https and www. tokens that target() takes
// become links; an address inside a word is found, as marked finds it (`foohttps://a.b`). It differs from marked only
// in ending an address at a STOP character, the search going on from there; that matters only in plain text, as a
// reply's own links are spanned by markdown.ts first.
export function urls(text: string): { start: number; end: number; link: string }[] {
  const found: { start: number; end: number; link: string }[] = [];
  const start = new RegExp(START); // its own lastIndex
  const stops = new RegExp(STOP);
  // The first STOP character at or after the search's place, found once for every start before it, marked's rule given
  // only the text up to it: cutting its token afterwards read the rest again from each address (Task 2's code review
  // re-check: 8,000 addresses in one-line JSON 1,082 ms).
  let stop = -1;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    if (stop < m.index) {
      stops.lastIndex = m.index;
      stop = stops.exec(text)?.index ?? text.length;
    }
    const cap = URL_RULE.exec(text.slice(m.index, stop));
    if (!cap) {
      start.lastIndex = m.index + 1;
      continue;
    }
    let token = cap[0];
    if (cap[2] !== "@") {
      for (let before = ""; before !== token; ) {
        before = token;
        token = BACKPEDAL.exec(token)?.[0] ?? "";
      }
    }
    start.lastIndex = m.index + Math.max(1, token.length);
    const link = cap[2] === "@" || !cap[1] || /^ftp/i.test(cap[1]) ? null : target(token);
    if (link !== null) found.push({ start: m.index, end: m.index + token.length, link });
  }
  return found;
}

// A link's text in OSC 8, each line in its own open and close so a line break inside it does not lose the link after
// it (plan, "What Ink does with OSC 8", Surprise 2), ended by BEL, as wrap-ansi reopens one with BEL (Surprise 1); an
// empty line bare.
export function linked(url: string, id: string, text: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? l : `\u001b]8;id=${id};${url}\u0007${l}\u001b]8;;\u0007`))
    .join("\n");
}
