import { marked, type Token } from "marked";
import { describe, expect, it } from "vitest";
import { hyperlinks, linked, target, urls } from "../../src/tui/links.js";

// Clickable links plan, Task 1: whether the terminal takes OSC 8 links. FORCE_HYPERLINK as Claude Code 2.1.323 reads it
// (`t7e`, `ps`), then the supports-hyperlinks v3.2.0 checks, then Claude Code's own list (`cw`).
const on = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux", level = 3, tty = true) =>
  hyperlinks(env, tty, level, platform);

describe("hyperlinks", () => {
  describe("FORCE_HYPERLINK", () => {
    it("turns links on for any value but the off words, even with no TTY and nothing else set", () => {
      for (const value of ["1", "2", "true", "yes", "on", "nope", "   "]) {
        expect(on({ FORCE_HYPERLINK: value }, "win32", 3, false), value).toBe(true);
      }
    });

    it("turns links off for 0, false, no and off in any case or spacing, even in Windows Terminal", () => {
      for (const value of ["0", "00", "0abc", " 0", "-0", "false", "FALSE", "no", "No", "off", " Off "]) {
        expect(on({ FORCE_HYPERLINK: value, WT_SESSION: "x" }, "win32"), value).toBe(false);
      }
    });

    it("is as unset when empty", () => {
      expect(on({ FORCE_HYPERLINK: "", WT_SESSION: "x" }, "win32")).toBe(true);
      expect(on({ FORCE_HYPERLINK: "" }, "win32")).toBe(false);
    });
  });

  it("is off when the output is not a TTY and nothing forces it", () => {
    expect(on({ WT_SESSION: "x" }, "win32", 3, false)).toBe(false);
    expect(on({ WT_SESSION: "x" }, "linux", 3, false)).toBe(false);
  });

  it("on win32, skips supports-hyperlinks' terminal checks: Windows Terminal on; console, vscode, WezTerm off", () => {
    expect(on({ WT_SESSION: "x" }, "win32")).toBe(true);
    expect(on({}, "win32")).toBe(false); // the old console sets none of the variables
    // supports-hyperlinks' Windows build returns before its TERM_PROGRAM checks
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" }, "win32")).toBe(false);
    expect(on({ TERM_PROGRAM: "WezTerm" }, "win32")).toBe(false);
    expect(on({ TERM_PROGRAM: "ghostty" }, "win32")).toBe(true); // Claude Code's own list
  });

  it("elsewhere, takes supports-hyperlinks' terminals and versions", () => {
    const program = (TERM_PROGRAM: string, TERM_PROGRAM_VERSION: string) => on({ TERM_PROGRAM, TERM_PROGRAM_VERSION });
    expect(program("vscode", "1.71.0")).toBe(false);
    expect(program("vscode", "1.72.0")).toBe(true);
    expect(program("vscode", "2.0.0")).toBe(true);
    expect(program("iTerm.app", "3.0.0")).toBe(true); // in Claude Code's list, whatever the version
    expect(program("WezTerm", "20200619")).toBe(false);
    expect(program("WezTerm", "20200620-160318-e00b076c")).toBe(true);
    expect(on({ VTE_VERSION: "0.50.0" })).toBe(false);
    expect(on({ VTE_VERSION: "5001" })).toBe(true); // reads as 0.50.1
    expect(on({ VTE_VERSION: "0.49.0" })).toBe(false);
    expect(on({ TERM: "alacritty" })).toBe(true);
    expect(on({ VTE_VERSION: "601" })).toBe(false); // reads as 0.6
  });

  it("takes NETLIFY before the colour check, and stops at TEAMCITY_VERSION as at CI", () => {
    expect(on({ NETLIFY: "true" }, "linux", 0)).toBe(true);
    expect(on({ TEAMCITY_VERSION: "2024.1", TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" })).toBe(false);
  });

  it("in CI or with no colour, skips supports-hyperlinks' terminals but not Claude Code's list", () => {
    expect(on({ CI: "1", TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" })).toBe(false);
    expect(on({ CI: "1", TERM_PROGRAM: "kitty" })).toBe(true);
    expect(on({ TERM_PROGRAM: "vscode", TERM_PROGRAM_VERSION: "1.90.0" }, "linux", 0)).toBe(false);
    expect(on({ WT_SESSION: "x" }, "linux", 0)).toBe(true);
  });

  it("takes each terminal in Claude Code's list", () => {
    for (const name of ["ghostty", "Hyper", "kitty", "alacritty", "iTerm.app", "iTerm2", "WarpTerminal"]) {
      expect(on({ TERM_PROGRAM: name }, "win32"), name).toBe(true);
    }
    expect(on({ LC_TERMINAL: "iTerm2" }, "win32")).toBe(true);
    expect(on({ TERMINAL_EMULATOR: "JetBrains-JediTerm" }, "win32")).toBe(true);
    expect(on({ TERM: "xterm-kitty" }, "win32")).toBe(true);
  });

  it("takes Windows Terminal inside tmux only by supports-hyperlinks' check, and tmux from 3.4", () => {
    // supports-hyperlinks' WT_SESSION check does not look at tmux; it stops at the colour check before it, and Claude
    // Code's own list skips WT_SESSION inside tmux
    expect(on({ WT_SESSION: "x", TMUX: "/tmp/tmux-1000/default,1,0" }, "linux", 3)).toBe(true);
    expect(on({ WT_SESSION: "x", TMUX: "/tmp/tmux-1000/default,1,0" }, "linux", 0)).toBe(false);
    const tmux = (TERM_PROGRAM_VERSION: string) => on({ TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION });
    expect(tmux("3.3a")).toBe(false);
    expect(tmux("3.4")).toBe(true);
    expect(tmux("4.0")).toBe(true);
  });
});

// Clickable links plan, Task 2: the address a link opens, the addresses in a text, and the escape around a link.
describe("target", () => {
  it("opens http and https as they are, and www. as https", () => {
    expect(target("https://x.y")).toBe("https://x.y");
    expect(target("HTTP://x.y")).toBe("HTTP://x.y");
    expect(target("www.x.y/a")).toBe("https://www.x.y/a");
  });

  it("opens no other scheme, and nothing relative", () => {
    for (const shown of ["ftp://x", "file:///c:/x", "mailto:a@b.c", "./a", "javascript:x"]) {
      expect(target(shown), shown).toBeNull();
    }
  });

  it("encodes each character outside 32-126, and opens nothing for text that is not well formed", () => {
    expect(target("https://de.wikipedia.org/wiki/Straße")).toBe("https://de.wikipedia.org/wiki/Stra%C3%9Fe");
    expect(target("https://x.y/\ud800")).toBeNull(); // a lone surrogate
  });

  it("opens nothing over 2083 bytes, the OSC 8 spec's VTE and iTerm2 limit", () => {
    const of = (bytes: number) => "https://x.y/" + "a".repeat(bytes - "https://x.y/".length);
    expect(target(of(2083))).toBe(of(2083));
    expect(target(of(2084))).toBeNull();
  });

  it("opens nothing with no host, nor a scheme with no //", () => {
    for (const shown of ["https://", "http://", "https://:80", "HTTPS://", "https:x.y"]) {
      expect(target(shown), shown).toBeNull();
    }
    expect(target("https://[::1]/")).toBe("https://[::1]/");
  });
});

describe("urls", () => {
  // marked's own links in the same text, as written, kept where they open http or https (marked's href gives a www.
  // address http://), so urls() and a reply's links cannot drift apart
  const markedLinks = (text: string): string[] => {
    const out: string[] = [];
    const walk = (tokens: Token[]) => {
      for (const t of tokens) {
        if (t.type === "link" && /^https?:\/\//i.test(t.href)) out.push(t.text);
        if ("tokens" in t && t.tokens) walk(t.tokens);
      }
    };
    walk(marked.lexer(text));
    return out;
  };
  const found = (text: string) => urls(text).map((u) => text.slice(u.start, u.end));

  it("finds the addresses marked finds, trailing punctuation left out and balanced brackets kept", () => {
    const cases: [string, string[]][] = [
      ["see https://example.com/a_(b)). ok", ["https://example.com/a_(b)"]],
      ["www.foo.com, and http://x.y/z?.", ["www.foo.com", "http://x.y/z"]],
      ["foohttps://a.b", ["https://a.b"]],
      ["x.www.foo.com", ["www.foo.com"]],
      ["http://user@www.x.com", ["http://user@www.x.com"]],
      ["(https://x.y)", ["https://x.y"]],
      ['"https://x.y/\'a\'"', ["https://x.y/'a"]],
      ["a https://a.b and https://c.d/e", ["https://a.b", "https://c.d/e"]],
      ["the end is https://x.y", ["https://x.y"]],
    ];
    for (const [text, want] of cases) {
      expect(found(text), text).toEqual(want);
      expect(markedLinks(text), text).toEqual(want);
    }
  });

  it("ends an address at a character it cannot hold as drawn: angle brackets, quotes, backquotes", () => {
    // Task 2's code review: marked's rule runs on over them, which in plain text opened the wrong page
    expect(found("<https://x.y>")).toEqual(["https://x.y"]);
    expect(found("<https://x.y/a>.")).toEqual(["https://x.y/a"]);
    expect(found('"https://x.y/a","b"')).toEqual(["https://x.y/a"]);
    expect(found("`https://x.y`")).toEqual(["https://x.y"]);
    // marked's rule sees the text only up to the next of them (the re-check), so an e-mail, mailto, xmpp or ftp token
    // beside one is still taken whole
    for (const text of ['"help@www.example.org"', 'mailto:a@www.b.com"x', "xmpp:a@www.b.com/r\\x", "<a.b@www.c.d>",
      '"ftp://www.q.r"', "`a@www.b.com`"]) {
      expect(urls(text), text).toEqual([]);
    }
  });

  it("gives each address its place and the address it opens", () => {
    expect(urls("go to www.x.y/a now")).toEqual([{ start: 6, end: 15, link: "https://www.x.y/a" }]);
  });

  it("finds none inside an e-mail, ftp, mailto or xmpp token, as marked takes each whole", () => {
    for (const text of ["help@www.example.org", "ftp://www.example.org", "FTP://www.q.r", "mailto:a@www.b.com",
      "xmpp:a@www.b.com/r", "a!b@www.c.com", "a@b.c", "www.@x.com"]) {
      expect(urls(text), text).toEqual([]);
      expect(markedLinks(text), text).toEqual([]);
    }
    expect(found("a.b@c www.d.e")).toEqual(["www.d.e"]);
    expect(markedLinks("a.b@c www.d.e")).toEqual(["www.d.e"]);
  });

  it("reads a long line with no address quickly", () => {
    // Without the e-mail start's lookbehind, a run of letters with no @ is read again from each of its letters: 40,000
    // took 585 ms and four times as long for each doubling (plan, "The design", scanprobe.mjs), so 200,000 about 15 s.
    // The fixed scan took 1 ms and 3 ms here.
    const run = "a".repeat(200_000);
    for (const text of [run, Array(5).fill(run).join(" ")]) {
      const start = performance.now();
      expect(urls(text)).toEqual([]);
      expect(performance.now() - start, `${text.length} characters`).toBeLessThan(500);
    }
  });

  it("reads a long line of addresses with no spaces quickly", () => {
    // Task 2's code review re-check: cutting marked's token at a STOP character after it had read on to the next space
    // read the rest again from each address, 8,000 in one-line JSON 1,082 ms and 50,000 joined by backslashes 8.3 s
    const json = JSON.stringify(Array.from({ length: 8_000 }, (_, id) => ({ id, url: `https://x.y/${id}` })));
    const slashed = Array.from({ length: 50_000 }, (_, id) => `https://x.y/${id}`).join("\\");
    for (const [text, n] of [[json, 8_000], [slashed, 50_000]] as const) {
      const start = performance.now();
      expect(urls(text)).toHaveLength(n);
      expect(performance.now() - start, `${n} addresses`).toBeLessThan(500);
    }
  });
});

describe("linked", () => {
  it("wraps each line in its own OSC 8 open and close, ended by BEL, an empty line bare", () => {
    expect(linked("https://x.y", "7-0", "go")).toBe("\u001b]8;id=7-0;https://x.y\u0007go\u001b]8;;\u0007");
    const one = (s: string) => `\u001b]8;id=1;https://x.y\u0007${s}\u001b]8;;\u0007`;
    expect(linked("https://x.y", "1", "a\nb")).toBe(`${one("a")}\n${one("b")}`);
    expect(linked("https://x.y", "1", "a\n\nb")).toBe(`${one("a")}\n\n${one("b")}`);
  });
});
