import { describe, expect, it } from "vitest";
import { type Editor, empty, load, move, segmenter } from "../../src/tui/editor.js";
import { press, start, type Vim, type VimMode } from "../../src/tui/vim.js";

// The text with the cursor shown as "|"; in NORMAL the cursor is on the character after it.
const show = (e: Editor) => `${e.text.slice(0, e.cursor)}|${e.text.slice(e.cursor)}`;
// An editor holding `text`, with "|" marking the cursor.
const at = (text: string) => ({ ...load(empty, text.replace("|", "")), cursor: text.indexOf("|") });
const NORMAL: Vim = { ...start, mode: "NORMAL" };
// Keys pressed in turn from `v`, NORMAL unless given: a string is one key a character, a list names
// keys such as "escape". Checks the text, cursor and mode they leave, and gives the rest.
function keys(text: string, typed: string | string[], shown: string, mode: VimMode = "NORMAL", v: Vim = NORMAL) {
  let r: ReturnType<typeof press> = { v, e: at(text) };
  for (const k of typeof typed === "string" ? [...segmenter.segment(typed)].map((s) => s.segment) : typed) r = press(r.v, r.e, k);
  expect({ shown: show(r.e), mode: r.v.mode }).toMatchObject({ shown, mode });
  return r;
}

// One test per row of Claude Code's "Vim editor mode" tables (code.claude.com/docs/en/interactive-mode,
// read 2026-10-28). `v`, `V` and `.` are the release 6 plan's Task 20's.
describe("vim: mode switching", () => {
  it("Esc: INSERT to NORMAL, the cursor back onto the character before", () => {
    keys("ab|c", ["escape"], "a|bc", "NORMAL", start);
    keys("ab\n|c", ["escape"], "ab\n|c", "NORMAL", start);
  });

  it("i: INSERT before the cursor, where typing goes", () => {
    keys("ab|c", "i", "ab|c", "INSERT");
    keys("ab|c", "ix", "abx|c", "INSERT");
  });

  it("I: INSERT at the line's first non-blank", () => {
    keys("x\n  ab|c", "I", "x\n  |abc", "INSERT");
  });

  it("a: INSERT after the cursor", () => {
    keys("a|bc", "a", "ab|c", "INSERT");
    keys("|\nx", "a", "|\nx", "INSERT"); // an empty line has nothing to go after
  });

  it("A: INSERT at the line's end", () => {
    keys("a|bc\nd", "A", "abc|\nd", "INSERT");
  });

  it("o: a new line below, in INSERT", () => {
    keys("a|bc\nd", "o", "abc\n|\nd", "INSERT");
  });

  it("O: a new line above, in INSERT", () => {
    keys("abc\nd|e", "O", "abc\n|\nde", "INSERT");
    keys("a|b", "O", "|\nab", "INSERT");
  });
});

describe("vim: navigation", () => {
  it("h j k l: left, down, up, right, not past a line's ends", () => {
    keys("ab|c", "h", "a|bc");
    keys("x\n|ab", "h", "x\n|ab");
    keys("a|bc", "l", "ab|c");
    keys("ab|c\nde", "l", "ab|c\nde");
    keys("ab|c\nde", "j", "abc\nd|e");
    keys("abc\nd|e", "k", "a|bc\nde");
  });

  it("j and k keep the column wanted across a shorter line, as Claude Code and Tachikoma's Up and Down do", () => {
    keys("abcd|e\nx\nabcdef", "jj", "abcde\nx\nabcd|ef");
    keys("abcde\nx\nabcd|ef", "kk", "abcd|e\nx\nabcdef");
    keys("abcd|e\nx\nabcdef", "jhj", "abcde\nx\n|abcdef"); // another motion sets the column anew
  });

  it("j and k forget the column when the cursor was moved from outside, as Claude Code's do", () => {
    let r = press(NORMAL, at("abcd|e\nxy\nabcdef"), "j");
    expect(show(r.e)).toBe("abcde\nx|y\nabcdef");
    r = press(r.v, move(r.e, 6), "j"); // App moved it, onto the x
    expect({ shown: show(r.e), mode: r.v.mode }).toMatchObject({ shown: "abcde\nxy\n|abcdef", mode: "NORMAL" });
  });

  it("$ then j or k keeps to the line's end, as Claude Code's does", () => {
    keys("a|bc\nabcdef", "$j", "abc\nabcde|f");
    keys("a|bc\nx\nabcdef", "$jj", "abc\nx\nabcde|f");
  });

  it("the arrows in NORMAL are h j k l", () => {
    keys("ab|c", ["left"], "a|bc");
    keys("a|bc", ["right"], "ab|c");
    keys("a|bc\nde", ["down"], "abc\nd|e");
    keys("abc\nd|e", ["up"], "a|bc\nde");
  });

  it("Space: right, and on to the next line's start, as Claude Code's does", () => {
    keys("a|bc", " ", "ab|c");
    keys("ab|c\nde", " ", "abc\n|de");
    keys("|\nde", " ", "\n|de");
  });

  it("Backspace: left, and back to the line before's end, as Claude Code's does", () => {
    keys("a|bc", ["backspace"], "|abc");
    keys("abc\n|de", ["backspace"], "ab|c\nde");
    keys("\n|de", ["backspace"], "|\nde");
  });

  it("w: the next word's start, punctuation being a word of its own and an empty line a word", () => {
    keys("|foo-bar baz", "w", "foo|-bar baz");
    keys("|foo-bar baz", "ww", "foo-|bar baz");
    keys("foo |bar\nbaz", "w", "foo bar\n|baz");
    keys("|foo\n\nbar", "w", "foo\n|\nbar");
    keys("foo |bar", "w", "foo ba|r"); // the last word: its last character
  });

  it("e: the word's end, or the next word's from a word's end", () => {
    keys("|foo bar", "e", "fo|o bar");
    keys("fo|o bar", "e", "foo ba|r");
  });

  it("b: the word's start, or the word before's", () => {
    keys("foo ba|r", "b", "foo |bar");
    keys("foo |bar", "b", "|foo bar");
    keys("foo\n|bar", "b", "|foo\nbar");
  });

  it("0: the line's start", () => {
    keys("x\n  ab|c", "0", "x\n|  abc");
  });

  it("$: the line's end, on its last character", () => {
    keys("a|bc\nd", "$", "ab|c\nd");
  });

  it("^: the line's first non-blank", () => {
    keys("x\n  ab|c", "^", "x\n  |abc");
  });

  it("gg: the beginning of the input", () => {
    keys("  ab\nc|d", "gg", "|  ab\ncd");
  });

  it("G: the beginning of the last line", () => {
    keys("ab|c\n  de", "G", "abc\n|  de");
  });

  it("f{char}: the next one on the line", () => {
    keys("a|bcabc", "fc", "ab|cabc");
    keys("a|bc\nc", "fx", "a|bc\nc");
    keys("a|b\nc", "fc", "a|b\nc"); // not past the line
  });

  it("F{char}: the one before on the line", () => {
    keys("abcab|c", "Fa", "abc|abc");
  });

  it("t{char}: just before the next one on the line", () => {
    keys("|abcd", "tc", "a|bcd");
  });

  it("T{char}: just after the one before on the line", () => {
    keys("abc|d", "Ta", "a|bcd");
  });

  it("; repeats the last f F t T, a repeated t passing the character it stopped before, as in Vim", () => {
    keys("|a.b.c", "f.;", "a.b|.c");
    keys("|a.b.c", "t.;", "a.|b.c");
    keys("|a.b.c", ";", "|a.b.c"); // nothing to repeat
  });

  it(", repeats the last f F t T the other way", () => {
    keys("|a.b.c", "f.;,", "a|.b.c");
  });

  it("%: the matching bracket, or from the next bracket on the line", () => {
    keys("|(a[b]c)", "%", "(a[b]c|)");
    keys("(a[b]c|)", "%", "|(a[b]c)");
    keys("(a|[b]c)", "%", "(a[b|]c)");
    keys("x|y (a)", "%", "xy (a|)");
    keys("x|y\n(a)", "%", "x|y\n(a)"); // no bracket on the line
  });

  it("/: Ctrl+R's search", () => {
    expect(keys("a|b", "/", "a|b").act).toBe("history:search");
  });

  it("j k and Up Down at the first or last line: the prompt history", () => {
    expect(keys("a|b", "k", "a|b").act).toBe("history:previous");
    expect(keys("a\nb|c", "j", "a\nb|c").act).toBe("history:next");
    expect(keys("a|b", ["up"], "a|b").act).toBe("history:previous");
    expect(keys("a|b", ["down"], "a|b").act).toBe("history:next");
    expect(keys("a\nb|c", "k", "|a\nbc").act).toBeUndefined();
  });

  it("?: the key list (the design's, not in the docs' table)", () => {
    expect(keys("a|b", "?", "a|b").act).toBe("help");
  });

  it("Enter: sends, from NORMAL too", () => {
    expect(keys("a|b", ["enter"], "a|b").act).toBe("submit");
  });
});

describe("vim: editing", () => {
  it("x: deletes the character", () => {
    keys("a|bc", "x", "a|c");
    keys("ab|c", "x", "a|b");
    keys("|\nab", "x", "|\nab");
  });

  it("r{char}: replaces the character, staying in NORMAL", () => {
    keys("a|bc", "rx", "a|xc");
  });

  it("dd: deletes the line", () => {
    keys("a\nb|b\nc", "dd", "a\n|c");
    keys("a\n  b|b\n  c", "dd", "a\n  |c"); // at the next line's first non-blank
    expect(keys("a\nb|b", "dd", "|a").v.register).toEqual({ text: "bb", linewise: true });
  });

  it("D: deletes to the line's end", () => {
    keys("a|bc\nd", "D", "|a\nd");
  });

  it("dw de db: delete a word, to its end, back", () => {
    keys("|foo bar", "dw", "|bar");
    keys("|foo bar", "de", "| bar");
    keys("foo ba|r", "db", "foo |r");
  });

  it("dw on a line's last word leaves the line break, and on an empty line takes the line, as in Vim", () => {
    keys("a |foo\nbar", "dw", "a| \nbar");
    keys("a\n|\nb", "dw", "a\n|b");
  });

  it("df{char} dt{char}: delete through, or up to, the next one on the line", () => {
    keys("|a,b,c", "df,", "|b,c");
    keys("|a,b,c", "dt,", "|,b,c");
  });

  it("dj dk: delete the line and the one below or above", () => {
    keys("a\nb|\nc\nd", "dj", "a\n|d");
    keys("a\nb\nc|\nd", "dk", "a\n|d");
    keys("a\n|b", "dj", "a\n|b"); // no line below
  });

  it("dgg dG: delete from the line to the first or last, whole lines", () => {
    keys("a\nb\nc|\nd", "dgg", "|d");
    keys("a\nb|\nc", "dG", "|a");
  });

  it("d0 c0 y0: back to the line's start", () => {
    keys("ab|cd", "d0", "|cd");
    keys("ab|cd", "c0", "|cd", "INSERT");
    expect(keys("ab|cd", "y0", "|abcd").v.register).toEqual({ text: "ab", linewise: false });
  });

  it("d% c% y%: through the bracket % goes to", () => {
    keys("x|(a)y", "d%", "x|y");
    keys("x|(a)y", "c%", "x|y", "INSERT");
    expect(keys("x(a|)y", "y%", "x|(a)y").v.register).toEqual({ text: "(a)", linewise: false });
  });

  it("cc: changes the line", () => {
    keys("a\n  b|c\nd", "cc", "a\n|\nd", "INSERT");
  });

  it("C: changes to the line's end", () => {
    keys("a|bc\nd", "C", "a|\nd", "INSERT");
  });

  it("cw ce cb: change a word, to its end, back; cw stops at the word's end as in Vim", () => {
    keys("|foo bar", "cw", "| bar", "INSERT");
    keys("fo|o bar", "cw", "fo| bar", "INSERT");
    keys("foo|  bar", "cw", "foo|bar", "INSERT"); // on blanks, as dw
    keys("|foo bar", "ce", "| bar", "INSERT");
    keys("foo ba|r", "cb", "foo |r", "INSERT");
  });

  it("s: deletes the character, in INSERT", () => {
    keys("a|bc", "s", "a|c", "INSERT");
  });

  it("S: clears the line, in INSERT", () => {
    keys("a\nb|c\nd", "S", "a\n|\nd", "INSERT");
  });

  it("yy Y: yank the line, the text and cursor staying", () => {
    for (const k of ["yy", "Y"]) expect(keys("a\nb|c", k, "a\nb|c").v.register).toEqual({ text: "bc", linewise: true });
  });

  it("yw ye yb: yank a word, to its end, back, the cursor going to the yank's start", () => {
    expect(keys("|foo bar", "yw", "|foo bar").v.register.text).toBe("foo ");
    expect(keys("f|oo bar", "ye", "f|oo bar").v.register.text).toBe("oo");
    expect(keys("foo ba|r", "yb", "foo |bar").v.register.text).toBe("ba");
  });

  it("p: puts after the cursor, a yanked line below", () => {
    keys("|ab cd", "yw$p", "ab cdab| ");
    keys("a\nb|c", "yyp", "a\nbc\n|bc");
  });

  it("P: puts before the cursor, a yanked line above", () => {
    keys("|ab cd", "ywP", "ab| ab cd");
    keys("a\nb|c", "yykP", "|bc\na\nbc");
  });

  it(">>: indents the line by two spaces, as Claude Code's does, passing an empty line", () => {
    keys("a|b", ">>", "  |ab");
    keys("  a|b", ">>", "    |ab");
    keys("|\nab", "2>>", "|\n  ab");
  });

  it("<<: takes off two spaces, else a tab, else up to two blanks, as Claude Code's does", () => {
    keys("    a|b", "<<", "  |ab");
    keys("\t\ta|b", "<<", "\t|ab");
    keys(" a|b", "<<", "|ab");
    keys(" \ta|b", "<<", "|ab");
  });

  it("J: joins the line below with one space", () => {
    keys("a|b\n  cd", "J", "ab| cd");
    keys("a|b \ncd", "J", "ab |cd"); // a blank there already
    keys("a|b\n)", "J", "ab|)");
    keys("a|b", "J", "a|b"); // no line below
  });

  it("u: undoes the last change, the cursor back where it was before it", () => {
    keys("foo ba|r", "dbu", "foo ba|r");
    keys("|foo bar", "dwxuu", "|foo bar");
  });

  it("each change is one undo step: x, dd, p, >>", () => {
    keys("a|bc", "xu", "a|bc");
    keys("a\nb|b\nc", "ddu", "a\nb|b\nc");
    keys("|ab", "ylpu", "|ab");
    keys("a|b", ">>u", "a|b");
  });

  it("a command into INSERT and what is typed there are one undo step; each INSERT its own", () => {
    keys("|foo bar", ["c", "w", "x", "y", "escape", "u"], "|foo bar");
    keys("a|b", ["o", "x", "escape", "u"], "a|b");
    keys("a|b", ["a", "x", "escape", "i", "y", "escape", "u"], "ab|x");
  });
});

describe("vim: counts", () => {
  it("on motions: 3w, 2j, 3fx", () => {
    keys("|a b c d", "3w", "a b c |d");
    keys("|a\nb\nc", "2j", "a\nb\n|c");
    keys("|axaxax", "3fx", "axaxa|x");
  });

  it("on operators: 2dd, d3w, and both counts multiplied as in Vim: 2d2w", () => {
    keys("a\n|b\nc\nd", "2dd", "a\n|d");
    keys("|a b c d", "d3w", "|d");
    keys("|a b c d e", "2d2w", "|e");
  });

  it("on commands: 3x, 2rx, 2p, 3G", () => {
    keys("|abcd", "3x", "|d");
    keys("|abc", "2rx", "x|xc");
    keys("|ab", "yl2p", "aa|ab");
    keys("|a\nb\nc\nd", "3G", "a\nb\n|c\nd");
  });

  it("0 after a count is part of it", () => {
    keys("|a b c d e f g h i j k", "10w", "a b c d e f g h i j |k");
  });

  it("too big a count stops where the text does, or is refused, at once", () => {
    keys("|a\nb", "999999999j", "a\n|b");
    keys("a\n|b", "999999999k", "|a\nb");
    keys("a|bc", "x50000000u", "a|bc");
    keys("|ab", "yl4294967296p", "|ab"); // Vim refuses a put too long to make (E1240)
    keys("|ab", "yy4294967296p", "|ab");
  });
});

describe("vim: characters made of several code points", () => {
  it("are one character to motions and deletes", () => {
    keys("a👍🏽|b", "h", "a|👍🏽b");
    keys("a|👍🏽b", "l", "a👍🏽|b");
    keys("a|👍🏽b", "x", "a|b");
    keys("ab👍🏽|", ["escape"], "ab|👍🏽", "NORMAL", start);
  });

  it("are one character to r, f and t, typed or looked for", () => {
    keys("a|bc", "r👍🏽", "a|👍🏽c");
    keys("|abc", "2r👍🏽", "👍🏽|👍🏽c");
    keys("|ab👍🏽c", "f👍🏽", "ab|👍🏽c");
    keys("|ab👍🏽c", "dt👍🏽", "|👍🏽c");
  });

  it("x deletes é whole, as one code point or a letter and its accent", () => {
    keys("a|\u00e9b", "x", "a|b");
    keys("a|e\u0301b", "x", "a|b");
  });
});

describe("vim: the editor as App leaves it", () => {
  it("with the cursor at the text's end, as load leaves it, works on the last character", () => {
    const loaded = (typed: string) => [...typed].reduce((r, k) => press(r.v, r.e, k), { v: NORMAL, e: load(empty, "ab\ncd") });
    expect(show(loaded("x").e)).toBe("ab\n|c");
    expect(show(loaded("D").e)).toBe("ab\n|c");
    expect(show(loaded("rz").e)).toBe("ab\nc|z");
    expect(show(loaded("h").e)).toBe("ab\n|cd");
  });

  it("empty, x dd p J w G >> change nothing and make no undo step", () => {
    for (const k of ["x", "dd", "p", "J", "w", "G", ">>"]) expect(keys("|", k, "|").e.undo).toEqual([]);
  });

  it("<< on a line with no indent makes no undo step", () => {
    expect(keys("a|b", "<<", "|ab").e.undo).toEqual([]);
  });
});

describe("vim: half-typed commands", () => {
  it("are kept while typed, and Esc or a key that is no motion drops them", () => {
    expect(keys("|ab", "2d", "|ab").v).toMatchObject({ count: "2", pending: "d" });
    keys("|ab", ["d", "escape", "l"], "a|b");
    keys("|ab", ["2", "escape", "l"], "a|b");
    keys("|ab", "dzl", "a|b");
  });

  it("Esc in NORMAL with nothing half typed is returned unchanged, for App", () => {
    expect(keys("a|b", ["escape"], "a|b").act).toBeUndefined();
  });
});

describe("vim: INSERT", () => {
  it("types a character; any other key but Esc is returned unchanged, for App", () => {
    keys("a|b", "x", "ax|b", "INSERT", start);
    keys("a|b", ["backspace"], "a|b", "INSERT", start);
  });
});

describe("vim: the last change, for the release 6 plan's Task 20's .", () => {
  it("is the keys of the command, with its count", () => {
    expect(keys("|foo bar", "dw", "|bar").v.lastChange).toEqual(["d", "w"]);
    expect(keys("|abcd", "3x", "|d").v.lastChange).toEqual(["3", "x"]);
    expect(keys("|foo bar", ["2", "c", "w", "x", "escape"], "|x").v.lastChange).toEqual(["2", "c", "w"]);
    expect(keys("|abcd", "yw", "|abcd").v.lastChange).toBeUndefined();
  });
});
