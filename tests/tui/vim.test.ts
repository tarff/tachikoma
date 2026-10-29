import { describe, expect, it } from "vitest";
import { apply, type Editor, empty, insertPicture, load, move, segmenter } from "../../src/tui/editor.js";
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
// read 2026-10-28; the "Text objects" and "Visual mode" tables and the `v`, `V` and `.` rows read again 2026-10-29).
describe("vim: mode switching", () => {
  it("v: VISUAL, the selection anchored at the cursor", () => {
    expect(keys("a|bc", "v", "a|bc", "VISUAL").v.anchor).toBe(1);
  });

  it("V: VISUAL LINE, the selection anchored at the cursor", () => {
    expect(keys("a|bc", "V", "a|bc", "VISUAL LINE").v.anchor).toBe(1);
  });

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
    expect(keys("a\nb|b", "dd", "|a").v.register).toEqual({ text: "bb", linewise: true, spans: [] });
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
    expect(keys("ab|cd", "y0", "|abcd").v.register).toEqual({ text: "ab", linewise: false, spans: [] });
  });

  it("d% c% y%: through the bracket % goes to", () => {
    keys("x|(a)y", "d%", "x|y");
    keys("x|(a)y", "c%", "x|y", "INSERT");
    expect(keys("x(a|)y", "y%", "x|(a)y").v.register).toEqual({ text: "(a)", linewise: false, spans: [] });
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
    for (const k of ["yy", "Y"]) expect(keys("a\nb|c", k, "a\nb|c").v.register).toEqual({ text: "bc", linewise: true, spans: [] });
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

  it(".: repeats the last change: dw, 3x, a put", () => {
    keys("|foo bar baz", "dw.", "|baz");
    keys("|abcdefg", "3x.", "|g");
    keys("|ab", "ylp.", "aa|ab");
    keys("a|b", ".", "a|b"); // no change yet
  });

  it(".: repeats a change into INSERT with what was typed there: ciwfoo<Esc>", () => {
    keys("|a b", ["c", "i", "w", "f", "o", "o", "escape", "w", "."], "foo fo|o");
    keys("|a\nb", ["o", "x", "escape", "."], "a\nx\n|x\nb");
  });

  // Not after an operator over h, l, Space, Backspace, % or a find, nor after >>, <<, J, r or a VISUAL change.
  it(".: a count before it applies to that . alone, and only for x, s, p, text objects and most operators, as Claude Code's own code has it", () => {
    expect(keys("|a b c d e", "dw2.", "|d e").v.lastChange).toEqual({ keys: ["d", "w"], count: "" });
    keys("|a b c d e", "dw2..", "|e");
    keys("|abcdef", "x3.", "|ef");
    keys("|abcdef", "dl3.", "|cdef");
    keys("|a,b,c,d", "df,2.", "|c,d");
    keys("|a\nb", ">>2.", "    |a\nb");
  });

  it(".: repeats what was typed in an INSERT no command began, as an insert at the cursor, as Claude Code records it", () => {
    keys("|", ["a", "b", "escape", "0", "."], "a|bab", "NORMAL", start);
    const dw = { keys: ["d", "w"], count: "" };
    expect(keys("a|b", ["escape"], "|ab", "NORMAL", { ...start, lastChange: dw }).v.lastChange).toEqual(dw); // nothing typed
  });

  it(".: an INSERT no command began whose edits reached past where it began has nothing to repeat", () => {
    let r = press(start, at("ab|"), "x");
    r = { ...r, e: apply(apply(r.e, "backspace"), "backspace") }; // App's Backspace, twice
    r = press(r.v, r.e, "escape");
    expect(show(r.e)).toBe("|a");
    expect(r.v.lastChange).toBeUndefined();
  });

  it(".: the change and its typing are one undo step", () => {
    keys("|foo bar", ["c", "w", "x", "escape", "w", ".", "u"], "x |bar");
  });

  // App, not vim, makes INSERT's other edits (the release 6 plan's Task 21): `edit` is App's action between two keys.
  function typed(text: string, before: string[], edit: Parameters<typeof apply>[1], after: string[]) {
    let r: ReturnType<typeof press> = { v: NORMAL, e: at(text) };
    for (const k of before) r = press(r.v, r.e, k);
    r = { ...r, e: apply(r.e, edit) };
    for (const k of after) r = press(r.v, r.e, k);
    return r;
  }

  it(".: what INSERT typed is the text left between where it began and what followed, whatever App's keys did there", () => {
    let r = typed("|foo bar", ["c", "w", "a", "b", "c"], "backspace", ["d", "escape", "w", "."]);
    expect(show(r.e)).toBe("abd ab|d");
    r = typed("|foo bar", ["c", "w", "a", "c"], "left", ["b", "escape", "w", "."]);
    expect(show(r.e)).toBe("abc ab|c");
    r = typed("|foo bar", ["c", "w", "a"], { type: "paste", text: "b\nc" }, ["escape", "w", "."]);
    expect(show(r.e)).toBe("ab\nc ab\n|c");
  });

  it(".: an INSERT whose edits reached past where it began has nothing to repeat, rather than repeating part of it", () => {
    const r = typed("foo |bar", ["i"], "backspace", ["x", "escape", "$", "."]);
    expect(show(r.e)).toBe("fooxba|r");
    expect(r.v.lastChange).toBeUndefined();
  });
});

// Where the docs' table leaves a text object's edges open, they are Claude Code 2.1.312's own (read 2026-10-29).
describe("vim: text objects", () => {
  it("iw aw: inner or around word; aw takes the blanks after, else those before; on blanks both take the blanks", () => {
    keys("foo b|ar baz", "diw", "foo | baz");
    keys("foo b|ar baz", "daw", "foo |baz");
    keys("foo b|ar", "daw", "fo|o");
    keys("foo-b|ar", "diw", "foo|-");
    keys("foo |  bar", "daw", "foo|bar");
    // A line break is a blank like any other, as Claude Code's dt() takes /\s/ for blanks over the whole text.
    keys("a\n|\nb", "diw", "a|b");
    keys("foo b|ar\nbaz", "daw", "foo |baz");
    keys("foo b|ar baz", "ciw", "foo | baz", "INSERT");
    expect(keys("foo b|ar baz", "yiw", "foo |bar baz").v.register.text).toBe("bar");
  });

  it("iW aW: inner or around WORD, any run of non-blanks", () => {
    keys("a foo-b|ar b", "diW", "a | b");
    keys("a foo-b|ar b", "daW", "a |b");
    keys("a foo-b|ar b", "ciW", "a | b", "INSERT");
    expect(keys("a foo-b|ar b", "yaW", "a |foo-bar b").v.register.text).toBe("foo-bar ");
  });

  it('i" a": inner or around double quotes, a pair on the cursor\'s line', () => {
    keys('say "hi |there" now', 'di"', 'say "|" now');
    keys('say "hi |there" now', 'da"', "say | now");
    keys('say |"hi" now', 'di"', 'say "|" now');
    keys('say "hi |there" now', 'ci"', 'say "|" now', "INSERT");
    expect(keys('say "hi |there" now', 'yi"', 'say "|hi there" now').v.register.text).toBe("hi there");
    keys('x|y "a"', 'di"', 'x|y "a"'); // not inside a pair
  });

  it("i' a': inner or around single quotes, paired in order along the line", () => {
    keys("say 'a|b' ok", "di'", "say '|' ok");
    keys("say 'a|b' ok", "da'", "say | ok");
    keys("say 'a|b' ok", "ci'", "say '|' ok", "INSERT");
    expect(keys("say 'a|b' ok", "ya'", "say |'ab' ok").v.register.text).toBe("'ab'");
    keys("it's 'a|b'", "di'", "it's 'a|b'"); // the apostrophe pairs with the first quote, as in Claude Code
  });

  it("i( a(: inner or around parentheses, the nearest pair around the cursor, over lines", () => {
    keys("f(a, (b|) c)", "di(", "f(a, (|) c)");
    keys("f(a, (b|) c)", "da(", "f(a, | c)");
    keys("f(|a, (b) c)", "di(", "f(|)");
    keys("f(a|)", "di(", "f(|)"); // on the closing one
    keys("f(\n  a|b\n)", "di(", "f(|)");
    keys("f(a|)", "ci(", "f(|)", "INSERT");
    expect(keys("f(a, (b|) c)", "ya(", "f(a, |(b) c)").v.register.text).toBe("(b)");
    keys("a|b", "di(", "a|b"); // none around
  });

  it("i[ a[: inner or around brackets", () => {
    keys("x[1, [|2]]", "di[", "x[1, [|]]");
    keys("x[1, [|2]]", "da[", "x[1, |]");
    keys("x[1, [|2]]", "ci[", "x[1, [|]]", "INSERT");
    expect(keys("x[1, [|2]]", "yi[", "x[1, [|2]]").v.register.text).toBe("2");
  });

  it("i{ a{: inner or around braces", () => {
    keys("if {a|b}", "di{", "if {|}");
    keys("if {a|b}", "da{", "if| ");
    keys("if {a|b}", "ci{", "if {|}", "INSERT");
    expect(keys("if {a|b}", "ya{", "if |{ab}").v.register.text).toBe("{ab}");
  });

  it("only after d, c and y; with nothing to take the command is dropped", () => {
    expect(keys("foo b|ar", ">i", "foo b|ar").v.pending).toBe(""); // Claude Code's > takes only a second >
    expect(keys("a|b", "di(h", "|ab").v.pending).toBe("");
  });
});

describe("vim: VISUAL", () => {
  it("motions extend the selection from the anchor, either way", () => {
    expect(keys("a|bc def", "vw", "abc |def", "VISUAL").v.anchor).toBe(1);
    keys("a|bc def", "vwd", "a|ef");
    keys("abc|d", "vhhd", "|a");
    keys("a|b\ncd", ["v", "enter"], "ab\nc|d", "VISUAL"); // Enter goes down a line, as Claude Code's does
    expect(keys("a|b", "vj", "a|b", "VISUAL").act).toBeUndefined(); // no prompt history from VISUAL
  });

  it("$ selects up to and with the line break, as in Vim", () => {
    keys("a|bc\nde", "v$", "abc|\nde", "VISUAL");
    keys("a|bc\nde", "v$d", "a|de");
    keys("a|bc", "v$d", "|a");
  });

  it("d x: delete the selection; in VISUAL LINE its lines", () => {
    for (const k of ["d", "x"]) keys("a|bcd", `vl${k}`, "a|d");
    const { v } = keys("a|bcd", "vld", "a|d");
    expect(v.register).toEqual({ text: "bc", linewise: false, spans: [] });
    expect(v).not.toHaveProperty("anchor");
    keys("a\nb|c\nd", "Vd", "a\n|d");
    keys("a\nb|c\nd\ne", "Vjd", "a\n|e");
  });

  it("y: yanks the selection, the cursor to its start; in VISUAL LINE the first line's start", () => {
    expect(keys("a|bcd", "vly", "a|bcd").v.register).toEqual({ text: "bc", linewise: false, spans: [] });
    keys("abc|d", "vhy", "ab|cd");
    expect(keys("a\nb|c", "Vy", "a\n|bc").v.register).toEqual({ text: "bc", linewise: true, spans: [] });
  });

  it("c s: change the selection, in INSERT", () => {
    for (const k of ["c", "s"]) keys("a|bcd", `vl${k}`, "a|d", "INSERT");
    keys("a\nb|c\nd", "Vc", "a\n|\nd", "INSERT");
  });

  it("p: replaces the selection with the register, which then holds what was replaced", () => {
    const yanked = (text: string, linewise = false): Vim => ({ ...NORMAL, register: { text, linewise, spans: [] } });
    expect(keys("a|bcd", "vlp", "aX|Yd", "NORMAL", yanked("XY")).v.register).toEqual({ text: "bc", linewise: false, spans: [] });
    expect(keys("a\nb|c\nd", "Vp", "a\n|X\nd", "NORMAL", yanked("X", true)).v.register).toEqual({ text: "bc", linewise: true, spans: [] });
    keys("a|bc\nd", "v$p", "a|X\nd", "NORMAL", yanked("X")); // the line break selected is kept
    keys("a|b", "vp", "a|b", "VISUAL"); // nothing yanked: nothing to put
    keys("a\nb|c\nd", "Vp", "a\n | \nd", "NORMAL", yanked("  ", true)); // a line of blanks: the cursor on its last
  });

  // Claude Code 2.1.312's own Wt() (read 2026-10-29): a yanked line keeps its line breaks; a yank that ended with a
  // line break loses it, and one comes back when the selection ended with one.
  it("p: puts line breaks as Claude Code's own code does", () => {
    const lines = keys("a|b\n\ncd", "Vjy", "|ab\n\ncd").v;
    keys("x|y", "vp", "x|ab\n", "NORMAL", lines);
    const charwise = keys("a|b\n\ncd", "vjy", "a|b\n\ncd").v;
    keys("x|y\nz", "v$p", "x|b\nz", "NORMAL", charwise);
  });

  it("r{char}: replaces every selected character, line breaks kept", () => {
    keys("a|bcd", "vlrx", "a|xxd");
    keys("a|b\ncd", "Vjrx", "|xx\nxx");
    keys("a|bcd", "vlrh", "a|hhd"); // a motion's key, or a digit, is the character
    keys("a|bcd", "vlr1", "a|11d");
  });

  it("~ u U: toggles, lowers or raises the selection's case", () => {
    keys("a|bCd", "vl~", "a|Bcd");
    keys("A|BCD", "vlu", "A|bcD");
    keys("a|bcd", "vlU", "a|BCd");
  });

  it("> <: indent or dedent the selected lines, a count times", () => {
    keys("a|b\ncd", "Vj>", "  |ab\n  cd");
    keys("    a|b\n  cd", "vj<", "  |ab\ncd");
    keys("a|b", "v2>", "    |ab");
  });

  it("J: joins the selected lines, two at least", () => {
    keys("a|b\ncd\nef", "VjjJ", "ab cd| ef");
    keys("a|b\ncd", "vJ", "ab| cd");
    keys("a|bcd\ne\nf", "vllJ", "abcd| e\nf"); // three characters on one line: two lines joined
    keys("a|b", "VJ", "|ab"); // no line below: VISUAL LINE leaves the cursor at the line's start, as Claude Code's does
  });

  it("o: swaps the cursor and the anchor", () => {
    expect(keys("a|bcd", "vllo", "a|bcd", "VISUAL").v.anchor).toBe(3);
    keys("a|bcde", "vllohd", "|e");
  });

  it('iw aw i" ...: select a text object, the anchor at its start', () => {
    expect(keys("foo b|ar baz", "viw", "foo ba|r baz", "VISUAL").v.anchor).toBe(4);
    keys("foo b|ar baz", "vawd", "foo |baz");
    keys('say "a|b" ok', 'vi"d', 'say "|" ok');
    keys("a|b", "vi(", "a|b", "VISUAL"); // none: the selection stays
  });

  it("v V: switch between VISUAL and VISUAL LINE, the anchor kept, or leave to NORMAL", () => {
    expect(keys("a|b\ncd", "vlV", "ab|\ncd", "VISUAL LINE").v.anchor).toBe(1);
    expect(keys("a|b\ncd", "Vv", "a|b\ncd", "VISUAL").v.anchor).toBe(1);
    expect(keys("a|b", "vv", "a|b").v.anchor).toBeUndefined();
    keys("a|b", "VV", "a|b");
    keys("a|b", "v$v", "a|b"); // back onto a character
  });

  it("Esc: NORMAL, or with a count or command half typed, drops only that", () => {
    keys("a|bc", ["v", "l", "escape"], "ab|c");
    expect(keys("a|bc", ["v", "2", "escape"], "a|bc", "VISUAL").v.count).toBe("");
    keys("a|bc", ["v", "r", "escape", "d"], "a|c");
  });

  it(".: repeats a VISUAL change over as many characters or lines from the cursor", () => {
    keys("|abcdef", "vld.", "|ef");
    keys("|ab cd", ["v", "l", "c", "x", "escape", "w", "."], "x |x");
    keys("|a\nb\nc\nd\ne", "Vjd.", "|e");
    keys("|abcd", "vlrx2l.", "xx|xx");
    keys("|ab cd", "vlpw.", "X |X", "NORMAL", { ...NORMAL, register: { text: "X", linewise: false, spans: [] } }); // what p put then
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

  // Claude Code 2.1.312's own code caps a count at 10,000 as it is typed (read 2026-10-29).
  it("too big a count stops where the text does, and is 10,000 at most, as Claude Code's own code caps it", () => {
    keys("|a\nb", "999999999j", "a\n|b");
    keys("a\n|b", "999999999k", "|a\nb");
    keys("a|bc", "x50000000u", "a|bc");
    keys("|ab", "yl4294967296p", `${"a".repeat(10000)}|ab`);
    keys("|ab", "yy4294967296p", `ab\n|${"ab\n".repeat(9999)}ab`);
    expect(keys("|ab", "d4294967296", "|ab").v.pending).toBe("d10000");
    keys("a|b", "v30000000>", `${"  ".repeat(10000)}|ab`); // VISUAL's > shifts 10,000 times, not 30,000,000
  });

  it("a put too long to make is refused, as Vim refuses it (E1240)", () => {
    const long: Vim = { ...NORMAL, register: { text: "a".repeat(200000), linewise: false, spans: [] } };
    keys("|ab", "9999p", "|ab", "NORMAL", long);
    keys("|ab", "9999p", "|ab", "NORMAL", { ...long, register: { ...long.register, linewise: true } });
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

describe("vim: the last change, for .", () => {
  it("is the keys of the command, its count apart, and what the INSERT it began typed", () => {
    expect(keys("|foo bar", "dw", "|bar").v.lastChange).toEqual({ keys: ["d", "w"], count: "" });
    expect(keys("|abcd", "3x", "|d").v.lastChange).toEqual({ keys: ["x"], count: "3" });
    expect(keys("|a b c d e", "2d2w", "|e").v.lastChange).toEqual({ keys: ["d", "w"], count: "4" });
    expect(keys("|foo bar", ["2", "c", "w", "x", "escape"], "|x").v.lastChange).toEqual({ keys: ["c", "w"], count: "2", typed: "x" });
    expect(keys("|abcd", "yw", "|abcd").v.lastChange).toBeUndefined();
  });
});

// Claude Code's docs, "Remap INSERT-mode key sequences" (read 2026-10-29): the first character is inserted, the second
// within one second takes it out and goes to NORMAL; after the second, or another key between, both stay.
describe("vim: vimInsertModeRemaps", () => {
  const pairs = { jj: "<Esc>", jk: "<Esc>" } as const;
  // Keys typed in INSERT from `text`, each [key, the time in ms], as App passes them.
  function timed(text: string, typed: [string, number][], v: Vim = start) {
    let r: ReturnType<typeof press> = { v, e: at(text) };
    for (const [k, now] of typed) r = press(r.v, r.e, k, { pairs, now });
    return r;
  }

  it("inserts the first character at once", () => {
    const r = timed("ab|", [["j", 0]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abj|", mode: "INSERT" });
  });

  it("takes the first out and goes to NORMAL when the second comes within 1 s, 1000 ms itself included as Claude Code's own code has it", () => {
    for (const later of [1, 1000]) {
      const r = timed("ab|", [["j", 5000], ["j", 5000 + later]]);
      expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "a|b", mode: "NORMAL" });
    }
    const r = timed("ab|", [["j", 0], ["k", 10]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "a|b", mode: "NORMAL" });
  });

  it("leaves both after 1 s, and the second can then begin the pair again", () => {
    let r = timed("ab|", [["j", 0], ["j", 1001]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abjj|", mode: "INSERT" });
    r = timed("ab|", [["j", 0], ["j", 1001], ["j", 1500]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "ab|j", mode: "NORMAL" });
  });

  it("leaves both when another key comes between, or the pair is the other way round", () => {
    let r = timed("ab|", [["j", 0], ["x", 1], ["j", 2]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abjxj|", mode: "INSERT" });
    r = timed("ab|", [["k", 0], ["j", 1]]);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abkj|", mode: "INSERT" });
  });

  it("leaves both when App's key or edit came between: Left, or a paste", () => {
    const first = timed("ab|", [["j", 0]]);
    const left = press(first.v, first.e, "left", { pairs, now: 1 }); // given back for App, which moves the cursor
    expect(left.v.remap).toBeUndefined();
    let r = press(left.v, apply(left.e, "left"), "j", { pairs, now: 2 });
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abj|j", mode: "INSERT" });
    r = press(first.v, apply(first.e, "left"), "j", { pairs, now: 1 }); // App moved the cursor without `press`
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abj|j", mode: "INSERT" });
    const before = timed("a|b", [["j", 0]]);
    r = press(before.v, apply(before.e, "delete"), "j", { pairs, now: 1 }); // the text changed, the cursor did not
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "ajj|", mode: "INSERT" });
    r = press(first.v, apply(first.e, { type: "paste", text: "x" }), "j", { pairs, now: 1 });
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "abjxj|", mode: "INSERT" });
  });

  it("leaves no undo step of its own, and . repeats what was typed before it", () => {
    const r = timed("a|b", [["i", 0], ["x", 1], ["j", 2], ["j", 3]], NORMAL);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "a|xb", mode: "NORMAL" });
    expect(show(press(r.v, r.e, "u").e)).toBe("a|b");
    expect(show(press(r.v, r.e, ".").e)).toBe("a|xxb");
  });

  // Claude Code 2.1.312's own code (read 2026-10-29): a remap ending an INSERT no command began records it as an
  // insert, even of nothing, unless the change before went into INSERT itself.
  it("ending an INSERT no command began, records what was typed there for ., even when nothing was", () => {
    let r = timed("a|b", [["x", 0], ["j", 1], ["j", 2]]);
    expect(show(r.e)).toBe("a|xb");
    expect(show(press(r.v, move(r.e, 0), ".").e)).toBe("|xaxb");
    const dw = { keys: ["d", "w"], count: "" };
    r = timed("ab|", [["j", 0], ["j", 1]], { ...start, lastChange: dw });
    expect(show(r.e)).toBe("a|b");
    expect(show(press(r.v, r.e, ".").e)).toBe("a|b"); // the empty insert took dw's place
    const cw = { keys: ["c", "w"], count: "", typed: "x" };
    expect(timed("ab|", [["j", 0], ["j", 1]], { ...start, lastChange: cw }).v.lastChange).toEqual(cw);
  });

  it("does nothing without pairs, or outside INSERT", () => {
    let r = press(start, at("ab|"), "j");
    r = press(r.v, r.e, "j");
    expect(show(r.e)).toBe("abjj|");
    expect(show(timed("a|b", [["j", 0], ["j", 1]], NORMAL).e)).toBe("a|b");
  });
});

// Release 6 design, "Which pictures a message carries": a marker's span goes only when one of its characters is
// deleted.
describe("vim: pictures' markers", () => {
  // `before`, picture #1's marker, then `after`, the cursor at `cursor`, in NORMAL.
  const withPicture = (before: string, after: string, cursor: number) =>
    move(apply(insertPicture(load(empty, before), 1), { type: "insert", text: after }), cursor);
  const spans = (e: Editor) => e.spans.map((s) => `${s.id}:${e.text.slice(s.from, s.to)}`);
  const pressed = (e: Editor, typed: string) => [...typed].reduce((r, k) => press(r.v, r.e, k), { v: NORMAL, e });

  it(">> and << keep the span of a marker on the line, as one undo step", () => {
    const right = pressed(withPicture("go ", " end", 0), ">>").e;
    expect(right.text).toBe("  go [Image #1] end");
    expect(spans(right)).toEqual(["1:[Image #1]"]);
    expect(right.undo).toHaveLength(3); // the marker's step, the typing, then the >>
    const left = pressed(right, "<<").e;
    expect(left.text).toBe("go [Image #1] end");
    expect(spans(left)).toEqual(["1:[Image #1]"]);
  });

  it("J keeps the span of a marker on the line it joins", () => {
    const e = pressed(withPicture("a\n", " b", 0), "J").e;
    expect(show(e)).toBe("a| [Image #1] b");
    expect(spans(e)).toEqual(["1:[Image #1]"]);
    expect(e.undo).toHaveLength(3); // the marker's step, the typing, then the J
  });

  it("r on a marker replaces the whole marker, the cursor on the new character", () => {
    const e = pressed(withPicture("go ", " end", 4), "rZ").e;
    expect(show(e)).toBe("go |Z end");
    expect(e.spans).toEqual([]);
  });

  // The release 6 plan, Task 20: yank and put copy pictures' spans.
  it("a deleted marker put twice gives two spans of one id", () => {
    const e = pressed(withPicture("go ", "", 3), "xpp").e;
    expect(e.text).toBe("go [Image #1][Image #1]");
    expect(spans(e)).toEqual(["1:[Image #1]", "1:[Image #1]"]);
  });

  it("a yanked marker put twice, and a count, give a span in every copy", () => {
    expect(spans(pressed(withPicture("go ", "", 3), "yl$pp").e)).toEqual(["1:[Image #1]", "1:[Image #1]", "1:[Image #1]"]);
    const e = pressed(withPicture("go ", "", 3), "yl$2p").e;
    expect(e.text).toBe("go [Image #1][Image #1][Image #1]");
    expect(spans(e)).toHaveLength(3);
  });

  it("a yanked line with a marker put gives the marker's span on the new line", () => {
    const e = pressed(withPicture("go ", "", 0), "yyp").e;
    expect(e.text).toBe("go [Image #1]\ngo [Image #1]");
    expect(e.spans.map((s) => [s.id, s.from])).toEqual([[1, 3], [1, 17]]);
  });

  it("a yank reaching into a marker takes the whole marker, as a delete does (choice 14)", () => {
    const r = pressed(withPicture("go ", " end", 3), "yl");
    expect(r.v.register).toEqual({ text: "[Image #1]", linewise: false, spans: [{ id: 1, from: 0, to: 10 }] });
  });

  it("p after the cursor on a marker puts after the whole marker, leaving it whole", () => {
    const e = pressed(withPicture("go ", "", 3), "ylp").e;
    expect(e.text).toBe("go [Image #1][Image #1]");
    expect(spans(e)).toHaveLength(2);
  });

  it("diw in a marker deletes the whole marker, which the register keeps with its span", () => {
    const r = pressed(withPicture("go ", " end", 5), "diw");
    expect(show(r.e)).toBe("go | end");
    expect(r.v.register.spans).toEqual([{ id: 1, from: 0, to: 10 }]);
  });

  it("VISUAL y and p carry the span; ~ keeps a marker and its span; r makes a marker one character", () => {
    const e = withPicture("go ", " x", 3);
    expect(spans(pressed(e, "v9ly$P").e)).toEqual(["1:[Image #1]", "1:[Image #1]"]);
    expect(spans(pressed(e, "yl$vp").e)).toEqual(["1:[Image #1]", "1:[Image #1]"]);
    const raised = pressed(e, "0v$~").e;
    expect(raised.text).toBe("GO [Image #1] X");
    expect(spans(raised)).toEqual(["1:[Image #1]"]);
    const replaced = pressed(e, "0v$rz").e;
    expect(show(replaced)).toBe("|zzzzzz");
    expect(replaced.spans).toEqual([]);
  });

  it("VISUAL ~ begun inside a marker leaves the cursor at the marker's start, as Claude Code's snaps out of one", () => {
    const e = pressed(withPicture("go ", " x", 5), "v$~").e;
    expect(show(e)).toBe("go |[Image #1] X");
    expect(spans(e)).toEqual(["1:[Image #1]"]);
  });

  it("a marker put before another keeps the spans in order, so a VISUAL ~ over both keeps both", () => {
    const e = pressed(withPicture("go ", "", 3), "ylP0v$~").e;
    expect(e.text).toBe("GO [Image #1][Image #1]");
    expect(spans(e)).toEqual(["1:[Image #1]", "1:[Image #1]"]);
  });
});

describe("vim: plain data", () => {
  // Every object in `x` frozen, so a change made in place throws.
  function frozen<T>(x: T): T {
    if (x && typeof x === "object" && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const y of Object.values(x)) frozen(y);
    }
    return x;
  }

  it("press changes nothing it is given, through a . and a remap", () => {
    const remaps = frozen({ pairs: { jj: "<Esc>" }, now: 0 } as const);
    let r: ReturnType<typeof press> = { v: structuredClone(NORMAL), e: at("|foo bar") };
    for (const k of ["c", "w", "x", "escape", "w", "."]) r = press(frozen(r.v), frozen(r.e), k, remaps);
    expect(show(r.e)).toBe("x |x");
    for (const k of ["a", "y", "j", "j"]) r = press(frozen(r.v), frozen(r.e), k, remaps);
    expect({ shown: show(r.e), mode: r.v.mode }).toEqual({ shown: "x x|y", mode: "NORMAL" });
  });
});
