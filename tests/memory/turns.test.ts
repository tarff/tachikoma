import { describe, expect, it } from "vitest";
import { FEEDBACK as SESSION_FEEDBACK } from "../../src/core/session.js";
import { type Message, marker as typesMarker, type Part } from "../../src/core/types.js";
import { lastTurn } from "../../src/tui/describe.js";
// @ts-expect-error: a build script in plain JavaScript, with no type file.
import { cut, FEEDBACK, marker, turnsOf } from "../../scripts/8d/turns.mjs";

// Made-up transcripts only, never the user's (8d plan, step 10). Each line as transcript.ts writes it: one JSON object
// a line, the start line first.
const AT = "2026-11-19T00:00:00.000Z";
const start = { t: "start", at: AT, v: 1, id: "s1", project: "/p", lead: "x", version: "0", print: false, system: "",
  tools: [] };
const msg = (m: Message) => ({ t: "message", at: AT, message: m });
const file = (...lines: (object | string)[]) =>
  `${[start, ...lines].map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;

const typed = (text: string, ...more: Part[]): Message => ({ role: "user", parts: [{ type: "text", text }, ...more] });
const reply = (text: string, ...calls: string[]): Message => ({
  role: "assistant",
  parts: [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...calls.map((id) => ({ type: "tool_call" as const, id, name: "shell", input: { command: `echo ${id}` } })),
  ],
});
const results = (...ids: string[]): Message => ({
  role: "user",
  parts: ids.map((id) => ({ type: "tool_result" as const, callId: id, output: "ok", isError: false })),
});
const background = (text: string): Message => ({ role: "user", parts: [{ type: "text", text, from: "tasks" }] });
const feedback = (text: string): Message => ({
  role: "user",
  parts: [{ type: "text", text: `${FEEDBACK}\n${text}`, from: "hooks" }],
});
const shortened = { t: "shortened", at: AT, system: "", message: { role: "user", parts: [{ type: "text",
  text: "Summary of the conversation so far." }] } };

describe("turns.mjs, the grouping rule", () => {
  it("uses the session's own feedback heading and picture marker", () => {
    expect(FEEDBACK).toBe(SESSION_FEEDBACK);
    expect(marker(7)).toBe(typesMarker(7));
  });

  it("keeps a typed turn with tool rounds as one turn", () => {
    const r = turnsOf(file(msg(typed("fix it")), msg(reply("Looking.", "c1")), msg(results("c1")),
      msg(reply("Now this.", "c2", "c3")), msg(results("c2", "c3")), msg(reply("Done."))));
    expect(r.apart).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ kind: "typed", n: 1, typed: "fix it", texts: ["Looking.", "Now this.", "Done."],
      calls: 3 });
  });

  it("gives a background turn after a typed one a turn of its own, its calls and text not in the first", () => {
    const r = turnsOf(file(msg(typed("start the build")), msg(reply("Started.", "c1")), msg(results("c1")),
      msg(reply("It runs in the background.")), msg(background("The build finished.")), msg(reply("Checking.", "c2")),
      msg(results("c2")), msg(reply("The build passed.")), msg(typed("thanks")), msg(reply("You are welcome."))));
    expect(r.apart).toEqual([]);
    expect(r.turns.map((t: { kind: string; n?: number }) => [t.kind, t.n])).toEqual([["typed", 1],
      ["background", undefined], ["typed", 2]]);
    expect(r.turns[0]).toMatchObject({ texts: ["Started.", "It runs in the background."], calls: 1 });
    expect(r.turns[1]).toMatchObject({ typed: "", texts: ["Checking.", "The build passed."], calls: 1 });
  });

  it("does not start a turn at a Stop hook's feedback", () => {
    const r = turnsOf(file(msg(typed("write the test")), msg(reply("Written.")), msg(feedback("Run it first.")),
      msg(reply("Running.", "c1")), msg(results("c1")), msg(reply("It passes."))));
    expect(r.apart).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ kind: "typed", texts: ["Written.", "Running.", "It passes."], calls: 1 });
  });

  it("does not split a turn at a shortening, and leaves the summary out of it", () => {
    const r = turnsOf(file(msg(typed("read the logs")), msg(reply("Reading.", "c1")), msg(results("c1")), shortened,
      msg(reply("Found it."))));
    expect(r.apart).toEqual([]);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]).toMatchObject({ typed: "read the logs", texts: ["Reading.", "Found it."] });
  });

  it("takes the typed words only, each picture as its marker", () => {
    const prompt: Message = { role: "user", parts: [
      { type: "text", text: "SessionStart hook:\nhello", from: "hooks" },
      { type: "text", text: "look at " },
      { type: "image", id: 3, mediaType: "image/png", file: "3.png" } as unknown as Part,
      { type: "text", text: " please" },
      { type: "text", text: "a resource's text", from: "server" },
      { type: "image", id: 4, mediaType: "image/png", file: "4.png", from: "server" } as unknown as Part,
      { type: "text", text: "a background answer", from: "tasks" },
      { type: "text", text: "Today's date is ...", from: "note", note: { date: "2026-11-19" } },
    ] };
    const r = turnsOf(file(msg(prompt), msg(reply("Seen."))));
    expect(r.turns[0]).toMatchObject({ kind: "typed", typed: "look at [Image #3] please", texts: ["Seen."] });
  });

  it("sets apart a turn with a damaged line, and marks one with a call with no result or that the file ends in", () => {
    const r = turnsOf(file(msg(typed("one")), msg(reply("A.")), "{not json", msg(typed("two")),
      msg(reply("B.", "c1")), msg(typed("three")), msg(reply("C.")), msg(typed("four")), msg(reply("D.", "c2"))));
    expect(r.apart).toEqual([{ kind: "typed", n: 1, reason: "damaged line" }]);
    // Q4 saves a turn however it ended, so a marked turn keeps its words and text (the user's choice, 2026-11-19).
    expect(r.turns.map((t: { n: number; mark: string | null; typed: string; texts: string[] }) =>
      [t.n, t.mark, t.typed, t.texts])).toEqual([
      [2, "call without a result", "two", ["B."]],
      [3, null, "three", ["C."]],
      [4, "file ends mid-turn", "four", ["D."]],
    ]);
  });

  it("starts its last turn where lastTurn starts it, on the same made-up messages", () => {
    const cases: Message[][] = [
      [typed("a"), reply("", "c1"), results("c1"), reply("x")],
      [typed("a"), reply("", "c1"), results("c1"), reply("x"), background("done"), reply("", "c2", "c3"),
        results("c2", "c3"), reply("y")],
      [typed("a"), reply("", "c1"), results("c1"), reply("x"), feedback("more"), reply("", "c2", "c3"),
        results("c2", "c3"), reply("y")],
      [typed("a"), reply("", "c1"), results("c1"), reply("x"), typed("b"), reply("", "c2", "c3"), results("c2", "c3"),
        reply("y"), feedback("again"), reply("", "c4", "c5", "c6", "c7"), results("c4", "c5", "c6", "c7"), reply("z")],
    ];
    for (const messages of cases) {
      const header = lastTurn(messages)[0]!.text;
      const r = turnsOf(file(...messages.map(msg)));
      expect(r.apart).toEqual([]);
      expect(`Last turn: ${r.turns.at(-1).calls} tool call${r.turns.at(-1).calls === 1 ? "" : "s"}`).toBe(header);
    }
  });
});

describe("turns.mjs, cutting a long turn into parts", () => {
  it("keeps a text at the limit whole and cuts one over it, every part but the last as long as allowed", () => {
    expect(cut("a".repeat(10), 10)).toEqual(["a".repeat(10)]);
    expect(cut("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("never cuts between the two halves of a character Node holds as a pair", () => {
    const text = `${"a".repeat(9)}\u{1F600}b`;
    expect(cut(text, 10)).toEqual(["a".repeat(9), "\u{1F600}b"]);
  });
});
