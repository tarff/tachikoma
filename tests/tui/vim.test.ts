import { describe, expect, it } from "vitest";
import { type Editor, empty, load } from "../../src/tui/editor.js";
import { press, start, type Vim } from "../../src/tui/vim.js";

// The text with the cursor shown as "|"; in NORMAL the cursor is on the character after it.
const show = (e: Editor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;
// An editor holding `text`, with "|" marking the cursor.
const at = (text: string) => ({ ...load(empty, text.replace("|", "")), cursor: text.indexOf("|") });
const NORMAL: Vim = { ...start, mode: "NORMAL" };
// Keys pressed in turn, from NORMAL unless `v` says otherwise: a string is one key a character, a
// list names keys such as "escape".
function keys(text: string, typed: string | string[], v: Vim = NORMAL) {
  let r: ReturnType<typeof press> = { v, e: at(text) };
  for (const k of typeof typed === "string" ? [...typed] : typed) r = press(r.v, r.e, k);
  return { shown: show(r.e), mode: r.v.mode, act: r.act, v: r.v, e: r.e };
}

// One test per row of Claude Code's "Vim editor mode" tables (code.claude.com/docs/en/interactive-mode,
// read 2026-10-28). `v`, `V` and `.` are Task 20's.
describe("vim: mode switching", () => {
  it("Esc: INSERT to NORMAL, the cursor back onto the character before, as in Vim", () => {
    expect(keys("ab|c", ["escape"], start)).toMatchObject({ shown: "a|bc", mode: "NORMAL" });
    expect(keys("ab\n|c", ["escape"], start)).toMatchObject({ shown: "ab\n|c", mode: "NORMAL" });
  });

  it("i: INSERT before the cursor, where typing goes", () => {
    expect(keys("ab|c", "i")).toMatchObject({ shown: "ab|c", mode: "INSERT" });
    expect(keys("ab|c", "ix").shown).toBe("abx|c");
  });

  it("I: INSERT at the line's first non-blank, as Vim's I", () => {
    expect(keys("x\n  ab|c", "I")).toMatchObject({ shown: "x\n  |abc", mode: "INSERT" });
  });

  it("a: INSERT after the cursor", () => {
    expect(keys("a|bc", "a")).toMatchObject({ shown: "ab|c", mode: "INSERT" });
    expect(keys("|\nx", "a").shown).toBe("|\nx"); // an empty line has nothing to go after
  });

  it("A: INSERT at the line's end", () => {
    expect(keys("a|bc\nd", "A")).toMatchObject({ shown: "abc|\nd", mode: "INSERT" });
  });

  it("o: a new line below, in INSERT", () => {
    expect(keys("a|bc\nd", "o")).toMatchObject({ shown: "abc\n|\nd", mode: "INSERT" });
  });

  it("O: a new line above, in INSERT", () => {
    expect(keys("abc\nd|e", "O")).toMatchObject({ shown: "abc\n|\nde", mode: "INSERT" });
  });
});

describe("vim: navigation", () => {
  it("h j k l: left, down, up, right, not past a line's ends, keeping the column", () => {
    expect(keys("ab|c", "h").shown).toBe("a|bc");
    expect(keys("x\n|ab", "h").shown).toBe("x\n|ab");
    expect(keys("a|bc", "l").shown).toBe("ab|c");
    expect(keys("ab|c", "l").shown).toBe("ab|c");
    expect(keys("ab|c\nde", "j").shown).toBe("abc\nd|e");
    expect(keys("abc\nd|e", "k").shown).toBe("a|bc\nde");
  });

  it("the arrows in NORMAL are h j k l", () => {
    expect(keys("ab|c", ["left"]).shown).toBe("a|bc");
    expect(keys("a|bc", ["right"]).shown).toBe("ab|c");
    expect(keys("a|bc\nde", ["down"]).shown).toBe("abc\nd|e");
    expect(keys("abc\nd|e", ["up"]).shown).toBe("a|bc\nde");
  });

  it("Space: right", () => {
    expect(keys("a|bc", " ").shown).toBe("ab|c");
  });

  it("w: the next word's start, punctuation being a word of its own and an empty line a word, as in Vim", () => {
    expect(keys("|foo-bar baz", "w").shown).toBe("foo|-bar baz");
    expect(keys("|foo-bar baz", "ww").shown).toBe("foo-|bar baz");
    expect(keys("foo |bar\nbaz", "w").shown).toBe("foo bar\n|baz");
    expect(keys("|foo\n\nbar", "w").shown).toBe("foo\n|\nbar");
    expect(keys("foo |bar", "w").shown).toBe("foo ba|r"); // the last word: its last character
  });

  it("e: the word's end, or the next word's from a word's end", () => {
    expect(keys("|foo bar", "e").shown).toBe("fo|o bar");
    expect(keys("fo|o bar", "e").shown).toBe("foo ba|r");
  });

  it("b: the word's start, or the word before's", () => {
    expect(keys("foo ba|r", "b").shown).toBe("foo |bar");
    expect(keys("foo |bar", "b").shown).toBe("|foo bar");
    expect(keys("foo\n|bar", "b").shown).toBe("|foo\nbar");
  });

  it("0: the line's start", () => {
    expect(keys("x\n  ab|c", "0").shown).toBe("x\n|  abc");
  });

  it("$: the line's end, on its last character", () => {
    expect(keys("a|bc\nd", "$").shown).toBe("ab|c\nd");
  });

  it("^: the line's first non-blank", () => {
    expect(keys("x\n  ab|c", "^").shown).toBe("x\n  |abc");
  });

  it("gg: the first line, at its first non-blank as in Vim", () => {
    expect(keys("ab\nc|d", "gg").shown).toBe("|ab\ncd");
    expect(keys("  ab\nc|d", "gg").shown).toBe("  |ab\ncd");
  });

  it("G: the last line, at its first non-blank as in Vim", () => {
    expect(keys("ab|c\n  de", "G").shown).toBe("abc\n  |de");
  });

  it("f{char}: the next one on the line", () => {
    expect(keys("a|bcabc", "fc").shown).toBe("ab|cabc");
    expect(keys("a|bc\nc", "fx").shown).toBe("a|bc\nc");
    expect(keys("a|b\nc", "fc").shown).toBe("a|b\nc"); // not past the line
  });

  it("F{char}: the one before on the line", () => {
    expect(keys("abcab|c", "Fa").shown).toBe("abc|abc");
  });

  it("t{char}: just before the next one on the line", () => {
    expect(keys("|abcd", "tc").shown).toBe("a|bcd");
  });

  it("T{char}: just after the one before on the line", () => {
    expect(keys("abc|d", "Ta").shown).toBe("a|bcd");
  });

  it("; repeats the last f F t T, a repeated t passing the character it stopped before, as in Vim", () => {
    expect(keys("|a.b.c", "f.;").shown).toBe("a.b|.c");
    expect(keys("|a.b.c", "t.;").shown).toBe("a.|b.c");
    expect(keys("|a.b.c", ";").shown).toBe("|a.b.c"); // nothing to repeat
  });

  it(", repeats the last f F t T the other way", () => {
    expect(keys("|a.b.c", "f.;,").shown).toBe("a|.b.c");
  });

  it("%: the matching bracket, or from the next bracket on the line", () => {
    expect(keys("|(a[b]c)", "%").shown).toBe("(a[b]c|)");
    expect(keys("(a[b]c|)", "%").shown).toBe("|(a[b]c)");
    expect(keys("(a|[b]c)", "%").shown).toBe("(a[b|]c)");
    expect(keys("x|y (a)", "%").shown).toBe("xy (a|)");
    expect(keys("x|y\n(a)", "%").shown).toBe("x|y\n(a)"); // no bracket on the line
  });

  it("/: Ctrl+R's search", () => {
    expect(keys("a|b", "/")).toMatchObject({ shown: "a|b", act: "history:search" });
  });

  it("j k and Up Down at the first or last line: the prompt history", () => {
    expect(keys("a|b", "k")).toMatchObject({ shown: "a|b", act: "history:previous" });
    expect(keys("a\nb|c", "j")).toMatchObject({ shown: "a\nb|c", act: "history:next" });
    expect(keys("a|b", ["up"]).act).toBe("history:previous");
    expect(keys("a|b", ["down"]).act).toBe("history:next");
    expect(keys("a\nb|c", "k").act).toBeUndefined();
  });

  it("?: the key list (the design's, not in the docs' table)", () => {
    expect(keys("a|b", "?").act).toBe("help");
  });

  it("Enter: sends, from NORMAL too", () => {
    expect(keys("a|b", ["enter"]).act).toBe("submit");
  });
});

describe("vim: editing", () => {
  it("x: deletes the character", () => {
    expect(keys("a|bc", "x").shown).toBe("a|c");
    expect(keys("ab|c", "x").shown).toBe("a|b");
    expect(keys("|\nab", "x").shown).toBe("|\nab");
  });

  it("r{char}: replaces the character, staying in NORMAL", () => {
    expect(keys("a|bc", "rx")).toMatchObject({ shown: "a|xc", mode: "NORMAL" });
  });

  it("dd: deletes the line", () => {
    expect(keys("a\nb|b\nc", "dd").shown).toBe("a\n|c");
    expect(keys("a\nb|b", "dd").shown).toBe("|a");
    expect(keys("a\n  b|b\n  c", "dd").shown).toBe("a\n  |c"); // at the next line's first non-blank
    expect(keys("a\nb|b", "dd").v.register).toEqual({ text: "bb", linewise: true });
  });

  it("D: deletes to the line's end", () => {
    expect(keys("a|bc\nd", "D").shown).toBe("|a\nd");
  });

  it("dw de db: delete a word, to its end, back", () => {
    expect(keys("|foo bar", "dw").shown).toBe("|bar");
    expect(keys("|foo bar", "de").shown).toBe("| bar");
    expect(keys("foo ba|r", "db").shown).toBe("foo |r");
  });

  it("dw on a line's last word leaves the line break, and on an empty line takes the line, as in Vim", () => {
    expect(keys("a |foo\nbar", "dw").shown).toBe("a| \nbar");
    expect(keys("a\n|\nb", "dw").shown).toBe("a\n|b");
  });

  it("df{char} dt{char}: delete through, or up to, the next one on the line", () => {
    expect(keys("|a,b,c", "df,").shown).toBe("|b,c");
    expect(keys("|a,b,c", "dt,").shown).toBe("|,b,c");
  });

  it("dj dk: delete the line and the one below or above", () => {
    expect(keys("a\nb|\nc\nd", "dj").shown).toBe("a\n|d");
    expect(keys("a\nb\nc|\nd", "dk").shown).toBe("a\n|d");
    expect(keys("a\n|b", "dj").shown).toBe("a\n|b"); // no line below
  });

  it("dgg dG: delete from the line to the first or last", () => {
    expect(keys("a\nb\nc|\nd", "dgg").shown).toBe("|d");
    expect(keys("a\nb|\nc", "dG").shown).toBe("|a");
  });

  it("d0 c0 y0: back to the line's start", () => {
    expect(keys("ab|cd", "d0").shown).toBe("|cd");
    expect(keys("ab|cd", "c0")).toMatchObject({ shown: "|cd", mode: "INSERT" });
    const y = keys("ab|cd", "y0");
    expect(y).toMatchObject({ shown: "|abcd", mode: "NORMAL" });
    expect(y.v.register).toEqual({ text: "ab", linewise: false });
  });

  it("d% c% y%: through the bracket % goes to", () => {
    expect(keys("x|(a)y", "d%").shown).toBe("x|y");
    expect(keys("x|(a)y", "c%")).toMatchObject({ shown: "x|y", mode: "INSERT" });
    expect(keys("x(a|)y", "y%").v.register).toEqual({ text: "(a)", linewise: false });
  });

  it("cc: changes the line", () => {
    expect(keys("a\n  b|c\nd", "cc")).toMatchObject({ shown: "a\n|\nd", mode: "INSERT" });
  });

  it("C: changes to the line's end", () => {
    expect(keys("a|bc\nd", "C")).toMatchObject({ shown: "a|\nd", mode: "INSERT" });
  });

  it("cw ce cb: change a word, to its end, back; cw stops at the word's end as in Vim", () => {
    expect(keys("|foo bar", "cw")).toMatchObject({ shown: "| bar", mode: "INSERT" });
    expect(keys("fo|o bar", "cw").shown).toBe("fo| bar");
    expect(keys("foo|  bar", "cw").shown).toBe("foo|bar"); // on blanks, as dw
    expect(keys("|foo bar", "ce")).toMatchObject({ shown: "| bar", mode: "INSERT" });
    expect(keys("foo ba|r", "cb")).toMatchObject({ shown: "foo |r", mode: "INSERT" });
  });

  it("s: deletes the character, in INSERT", () => {
    expect(keys("a|bc", "s")).toMatchObject({ shown: "a|c", mode: "INSERT" });
  });

  it("S: clears the line, in INSERT", () => {
    expect(keys("a\nb|c\nd", "S")).toMatchObject({ shown: "a\n|\nd", mode: "INSERT" });
  });

  it("yy Y: yank the line, the cursor staying", () => {
    for (const k of ["yy", "Y"]) {
      const y = keys("a\nb|c", k);
      expect(y.shown).toBe("a\nb|c");
      expect(y.v.register).toEqual({ text: "bc", linewise: true });
    }
  });

  it("yw ye yb: yank a word, to its end, back", () => {
    expect(keys("|foo bar", "yw").v.register.text).toBe("foo ");
    expect(keys("|foo bar", "ye").v.register.text).toBe("foo");
    const y = keys("foo ba|r", "yb");
    expect(y.v.register.text).toBe("ba");
    expect(y.shown).toBe("foo |bar");
  });

  it("p: puts after the cursor, a yanked line below", () => {
    expect(keys("|ab cd", "yw$p").shown).toBe("ab cdab| ");
    expect(keys("a\nb|c", "yyp").shown).toBe("a\nbc\n|bc");
  });

  it("P: puts before the cursor, a yanked line above", () => {
    expect(keys("|ab cd", "ywP").shown).toBe("ab| ab cd");
    expect(keys("a\nb|c", "yykP").shown).toBe("|bc\na\nbc");
  });

  it(">>: indents the line by Vim's default shiftwidth, 8 columns as a tab", () => {
    expect(keys("a|b", ">>").shown).toBe("\t|ab");
    expect(keys("  a|b", ">>").shown).toBe("\t  |ab");
  });

  it("<<: takes 8 columns of indent off the line", () => {
    expect(keys("\t a|b", "<<").shown).toBe(" |ab");
    expect(keys("  a|b", "<<").shown).toBe("|ab");
  });

  it("J: joins the line below with one space, as in Vim", () => {
    expect(keys("a|b\n  cd", "J").shown).toBe("ab| cd");
    expect(keys("a|b \ncd", "J").shown).toBe("ab |cd"); // a blank there already
    expect(keys("a|b\n)", "J").shown).toBe("ab|)");
    expect(keys("a|b", "J").shown).toBe("a|b"); // no line below
  });

  it("u: undoes the last change, the cursor back where it was", () => {
    expect(keys("a|bc", "xu").shown).toBe("a|bc");
    expect(keys("foo ba|r", "dbu").shown).toBe("foo ba|r");
    expect(keys("|foo bar", "dwxuu").shown).toBe("|foo bar");
  });

  it("every change is one undo step: cw and the word typed in its place undo together", () => {
    const r = keys("|foo bar", ["c", "w", "x", "y", "escape", "u"]);
    expect(r).toMatchObject({ shown: "|foo bar", mode: "NORMAL" });
    expect(keys("a|b", ["o", "x", "escape", "u"]).shown).toBe("a|b");
  });
});

describe("vim: counts", () => {
  it("on motions: 3w, 2j, 3fx", () => {
    expect(keys("|a b c d", "3w").shown).toBe("a b c |d");
    expect(keys("|a\nb\nc", "2j").shown).toBe("a\nb\n|c");
    expect(keys("|axaxax", "3fx").shown).toBe("axaxa|x");
  });

  it("on operators: 2dd, d3w, and both counts multiplied as in Vim: 2d2w", () => {
    expect(keys("a\n|b\nc\nd", "2dd").shown).toBe("a\n|d");
    expect(keys("|a b c d", "d3w").shown).toBe("|d");
    expect(keys("|a b c d e", "2d2w").shown).toBe("|e");
  });

  it("on commands: 3x, 2rx, 2p, 3G", () => {
    expect(keys("|abcd", "3x").shown).toBe("|d");
    expect(keys("|abc", "2rx").shown).toBe("x|xc");
    expect(keys("|ab", "yl2p").shown).toBe("aa|ab");
    expect(keys("|a\nb\nc\nd", "3G").shown).toBe("a\nb\n|c\nd");
  });

  it("0 after a count is part of it", () => {
    expect(keys("|a b c d e f g h i j k", "10w").shown).toBe("a b c d e f g h i j |k");
  });
});

describe("vim: characters made of several code points", () => {
  it("are one character to motions and deletes", () => {
    expect(keys("a👍🏽|b", "h").shown).toBe("a|👍🏽b");
    expect(keys("a|👍🏽b", "l").shown).toBe("a👍🏽|b");
    expect(keys("a|👍🏽b", "x").shown).toBe("a|b");
    expect(keys("ab👍🏽|", ["escape"], start).shown).toBe("ab|👍🏽");
  });
});

describe("vim: half-typed commands", () => {
  it("are kept while typed, and Esc or a key that is no motion drops them", () => {
    expect(keys("|ab", "2d").v).toMatchObject({ count: "2", pending: "d" });
    expect(keys("|ab", ["d", "escape", "l"]).shown).toBe("a|b");
    expect(keys("|ab", "dzl").shown).toBe("a|b");
  });

  it("Esc in NORMAL with nothing half typed changes nothing, so App's Esc does what it does", () => {
    expect(keys("a|b", ["escape"])).toMatchObject({ shown: "a|b", mode: "NORMAL", act: undefined });
  });
});

describe("vim: INSERT", () => {
  it("types a character, and leaves other keys to App's own editing", () => {
    expect(keys("a|b", "x", start).shown).toBe("ax|b");
    expect(keys("a|b", ["backspace"], start).shown).toBe("a|b");
  });
});

describe("vim: the last change, for Task 20's .", () => {
  it("is the keys of the command, with its count", () => {
    expect(keys("|foo bar", "dw").v.lastChange).toEqual(["d", "w"]);
    expect(keys("|abcd", "3x").v.lastChange).toEqual(["3", "x"]);
    expect(keys("|abcd", "yw").v.lastChange).toBeUndefined();
  });

  it("is, for a command into INSERT, the text typed there and Esc", () => {
    expect(keys("|foo bar", ["c", "w", "x", "y", "escape"]).v.lastChange).toEqual(["c", "w", "x", "y", "escape"]);
    expect(keys("a|b", ["a", "z", "escape"]).v.lastChange).toEqual(["a", "z", "escape"]);
  });
});
