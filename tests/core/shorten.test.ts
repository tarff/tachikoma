import { describe, expect, it } from "vitest";
import { callText } from "../../src/core/exportText.js";
import { Sizes } from "../../src/core/fit.js";
import {
  CANCELLED,
  EMPTY_SUMMARY,
  INSTRUCTIONS,
  ONE_EXCHANGE,
  PROMPT_TOO_BIG,
  STILL_TOO_BIG,
  shorten,
  type When,
} from "../../src/core/shorten.js";
import type { CompletionRequest, Message, Provider, ToolCall, ToolSpec, Turn, Usage } from "../../src/core/types.js";
import type { Workspace } from "../../src/exec/workspace.js";

// Release 8a plan, Task 11 (design, "How shortening works"; choices 22-23).

const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const reply = (text: string): Turn => ({ parts: [{ type: "text", text }], usage });
const spec: ToolSpec = { name: "read_file", description: "Reads a file.", inputSchema: { type: "object" } };
const png = { type: "image", id: 1, mediaType: "image/png", data: Buffer.from("a picture's bytes") } as const;

const user = (text: string): Message => ({ role: "user", parts: [{ type: "text", text }] });
const said = (text: string): Message => ({ role: "assistant", parts: [{ type: "text", text }] });
const call = (id: string, path: string): ToolCall => ({ type: "tool_call", id, name: "read_file", input: { path } });
const asks = (c: ToolCall): Message => ({ role: "assistant", parts: [c] });
const results = (id: string, output: string): Message => ({ role: "user", parts: [{ type: "tool_result", callId: id, output, isError: false }] });

class TooLong extends Error {}

// A scripted lead that records each request's messages, and calls a TooLong error too long.
class Lead implements Provider {
  readonly id = "fake:lead";
  readonly seen: Message[][] = [];
  constructor(private readonly turns: (Turn | Error | ((req: CompletionRequest) => Turn))[]) {}
  async complete(req: CompletionRequest): Promise<Turn> {
    this.seen.push(structuredClone(req.messages));
    const next = this.turns.shift();
    if (!next) throw new Error("Lead ran out of turns");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req) : next;
  }
  tooLong(err: unknown): boolean {
    return err instanceof TooLong;
  }
}

// A project of in-memory files at /p; a path starting ../ is outside it, and a file not in `files` cannot be read.
function workspace(files: Record<string, string>): Workspace {
  const no = () => Promise.reject(new Error("not used"));
  return {
    root: "/p",
    resolve: async (p) => ({ abs: `/p/${p}`, outside: p.startsWith("../"), shown: p }),
    readText: async (abs) => {
      const text = files[abs.slice("/p/".length)];
      if (text === undefined) throw new Error(`ENOENT: ${abs}`);
      return text;
    },
    writeText: no,
    find: no,
    search: no,
    branch: no,
  };
}

// Sizes that know the fake lead at 1 token a character, so a test can size the window by characters.
function counted(): Sizes {
  const sizes = new Sizes();
  sizes.learn("fake:lead", 1, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  return sizes;
}

type Args = Parameters<typeof shorten>[0];
function run(lead: Lead, messages: Message[], when: When, more: Partial<Args> = {}) {
  const used: Parameters<Args["onUsage"]>[0][] = [];
  const s: Args = {
    lead,
    system: "sys",
    messages,
    tools: [spec],
    calls: [],
    workspace: workspace({}),
    sizes: new Sizes(), // no ratio and no exact count: every fit is unknown, so it passes
    window: 1_000_000,
    onUsage: (u) => used.push(u),
    ...more,
  };
  return { used, result: shorten(s, when) };
}

const instructions = { type: "text", text: INSTRUCTIONS } as const;
const SHORTENED = "This conversation was shortened. A summary of everything before this point:\n\n";
const REQUEST = "The request being worked on, word for word:\n";
const ROUND = "The latest round of tool calls, and their results:\n";
const FILES = "The files read or edited in this session, as they are now:\n";
const text = (m: Message) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
// Whether every call in a request has its result in it.
const complete = (messages: Message[]) => {
  const answered = new Set(messages.flatMap((m) => m.parts.flatMap((p) => (p.type === "tool_result" ? [p.callId] : []))));
  return messages.every((m) => m.parts.every((p) => p.type !== "tool_call" || answered.has(p.id)));
};

describe("between turns", () => {
  it("summarises a history with no tool calls whole, without a reply's lead, into one message", async () => {
    const history = [user("hi"), { ...said("hello"), lead: "fake:lead" }, user("do x"), said("done")];
    const lead = new Lead([reply("SUMMARY")]);
    const { result } = run(lead, history, "between");
    expect(await result).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}SUMMARY` }] }], summary: "SUMMARY" });
    expect(lead.seen).toEqual([[user("hi"), said("hello"), user("do x"), said("done"), { role: "user", parts: [instructions] }]]);
  });

  it("summarises a history whose latest round is followed by plain exchanges whole, leaving nothing out", async () => {
    const c1 = call("c1", "a.txt");
    const history = [user("p1"), asks(c1), results("c1", "A"), said("done"), user("p2"), said("ok")];
    const lead = new Lead([reply("SUMMARY")]);
    const { result } = run(lead, history, "between");
    expect(await result).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}SUMMARY` }] }], summary: "SUMMARY" });
    expect(lead.seen).toEqual([[...history, { role: "user", parts: [instructions] }]]);
  });

  it("joins the instructions to a history's last message when it is the user's", async () => {
    const c1 = call("c1", "a.txt");
    const lead = new Lead([reply("SUMMARY")]);
    await run(lead, [user("p1"), asks(c1), results("c1", "A")], "between").result;
    expect(lead.seen[0]).toEqual([user("p1"), asks(c1), { role: "user", parts: [...results("c1", "A").parts, instructions] }]);
  });

  it("adds /compact's words as what to focus on", async () => {
    const lead = new Lead([reply("SUMMARY")]);
    await run(lead, [user("hi"), said("hello")], "between", { focus: "the tests" }).result;
    expect(lead.seen[0]!.at(-1)).toEqual({ role: "user", parts: [{ type: "text", text: `${INSTRUCTIONS}\n\nFocus on: the tests` }] });
  });

  it("refuses a summary that does not fit the window", async () => {
    const lead = new Lead([reply("S".repeat(500))]);
    const { result } = run(lead, [user("hi"), said("hello")], "between", { sizes: counted(), window: 300 });
    expect(await result).toEqual({ problem: STILL_TOO_BIG });
  });
});

describe("at the start of a turn", () => {
  it("summarises everything before the prompt and keeps the prompt whole, with its picture", async () => {
    const prompt: Message = { role: "user", parts: [{ type: "text", text: "look at " }, png, { type: "text", text: " please" }] };
    const lead = new Lead([reply("SUMMARY")]);
    const done = await run(lead, [user("p1"), said("r1"), prompt], "start").result;
    expect(lead.seen).toEqual([[user("p1"), said("r1"), { role: "user", parts: [instructions] }]]);
    expect(done).toEqual({
      messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}SUMMARY\n\n${REQUEST}look at ` }, png, { type: "text", text: " please" }] }],
      summary: "SUMMARY",
    });
  });

  it("returns the problem when the prompt alone does not fit, and sends nothing", async () => {
    const lead = new Lead([]);
    const { result } = run(lead, [user("p1"), said("r1"), user("p".repeat(5000))], "start", { sizes: counted(), window: 3000 });
    expect(await result).toEqual({ problem: PROMPT_TOO_BIG });
    expect(lead.seen).toEqual([]);
  });
});

describe("during a turn", () => {
  const c1 = call("c1", "a.txt");
  const c2 = call("c2", "b.txt");
  const round: Message = { role: "assistant", parts: [{ type: "text", text: "Now b." }, c2] };
  const turn = (output: string) => [user("p1"), said("a1"), user("the prompt"), asks(c1), results("c1", "A"), round, results("c2", output)];

  it("summarises up to the round's reply, with no call left without its result", async () => {
    const lead = new Lead([reply("SUMMARY")]);
    await run(lead, turn("B"), "during").result;
    expect(lead.seen).toEqual([[user("p1"), said("a1"), user("the prompt"), asks(c1), { role: "user", parts: [...results("c1", "A").parts, instructions] }]]);
    expect(complete(lead.seen[0]!)).toBe(true);
  });

  it("keeps the prompt whole and the latest round as text", async () => {
    const lead = new Lead([reply("SUMMARY")]);
    const done = await run(lead, turn("B"), "during").result;
    const kept = `${SHORTENED}SUMMARY\n\n${REQUEST}the prompt\n\n${ROUND}Now b.\n${callText(c2, "B")}`;
    expect(done).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: kept }] }], summary: "SUMMARY" });
    expect(kept).toContain('● read_file {\n  "path": "b.txt"\n}\n  ⎿ B');
  });

  it("summarises the round too, as a complete exchange, when it does not fit with the prompt", async () => {
    const big = "x".repeat(5000);
    const lead = new Lead([reply("SUMMARY")]);
    const done = await run(lead, turn(big), "during", { sizes: counted(), window: 3000 }).result;
    expect(lead.seen).toEqual([[...turn(big).slice(0, -1), { role: "user", parts: [...results("c2", big).parts, instructions] }]]);
    expect(done).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}SUMMARY\n\n${REQUEST}the prompt` }] }], summary: "SUMMARY" });
  });

  it("summarises the round too when the summary leaves no room for it", async () => {
    const lead = new Lead([reply("S".repeat(1000)), reply("SHORT")]);
    const done = await run(lead, turn("x".repeat(1000)), "during", { sizes: counted(), window: 2000 }).result;
    expect(lead.seen[1]).toHaveLength(turn("").length);
    expect(done).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}SHORT\n\n${REQUEST}the prompt` }] }], summary: "SHORT" });
  });

  it("returns the problem when the prompt alone does not fit", async () => {
    const history = [user("p1"), said("a1"), user("p".repeat(5000)), round, results("c2", "B")];
    const lead = new Lead([]);
    expect(await run(lead, history, "during", { sizes: counted(), window: 3000 }).result).toEqual({ problem: PROMPT_TOO_BIG });
    expect(lead.seen).toEqual([]);
  });
});

describe("files", () => {
  const read = (path: string, name = "read_file") => ({ name, input: { path } });
  const files = { "a.txt": "A\n", "b.txt": "B\n", "c.txt": "C\n", "d.txt": "D\n", "e.txt": "E\n", "f.txt": "F\n", "g.txt": "G\n" };
  async function filesPart(calls: Args["calls"], more: Partial<Args> = {}) {
    const args = { calls, workspace: workspace(files), sizes: counted(), ...more };
    const done = await run(new Lead([reply("S")]), [user("hi"), said("hello")], "between", args).result;
    if (!("messages" in done)) throw new Error(done.problem);
    return text(done.messages[0]!).split(FILES)[1];
  }

  it("names the most recent first, each once, 5 at most, with their contents as they are now", async () => {
    const calls: Args["calls"] = [read("a.txt"), read("b.txt"), read("c.txt", "write_file"), read("d.txt", "edit_file"), read("e.txt")];
    calls.push(read("f.txt"), read("g.txt"), { name: "bash", input: { command: "ls" } }, read("b.txt"));
    expect(await filesPart(calls)).toBe("--- b.txt ---\nB\n--- g.txt ---\nG\n--- f.txt ---\nF\n--- e.txt ---\nE\n--- d.txt ---\nD");
  });

  it("skips a file outside the project, which takes no place among the 5", async () => {
    const calls = [read("a.txt"), read("b.txt"), read("c.txt"), read("d.txt"), read("e.txt"), read("../out.txt")];
    expect(await filesPart(calls)).toBe("--- e.txt ---\nE\n--- d.txt ---\nD\n--- c.txt ---\nC\n--- b.txt ---\nB\n--- a.txt ---\nA");
  });

  it("names a file over 5,000 tokens without its content", async () => {
    // 4,998 characters are 5,000 as a text part's (choice 16), at 1 token a character.
    const more = { workspace: workspace({ "big.txt": "x".repeat(4999), "edge.txt": "y".repeat(4998) }) };
    expect(await filesPart([read("edge.txt"), read("big.txt")], more)).toBe(
      `--- big.txt (over 5,000 tokens; read it again if needed) ---\n--- edge.txt ---\n${"y".repeat(4998)}`,
    );
  });

  it("names a file without its content while the lead has no ratio", async () => {
    expect(await filesPart([read("a.txt")], { sizes: new Sizes() })).toBe("--- a.txt (size not known yet; read it again if needed) ---");
  });

  it("names a file that cannot be read", async () => {
    expect(await filesPart([read("gone.txt"), read("a.txt")])).toBe("--- a.txt ---\nA\n--- gone.txt (could not be read) ---");
  });
});

describe("pieces", () => {
  const history = [user("p1"), said("r1"), user("p2"), said("r2")];
  const combined = (first: string, second: string) => [{ role: "user", parts: [{ type: "text", text: `${first}\n\n${second}` }, instructions] }];

  it("sends two halves split at an exchange when the whole is too long, then combines their summaries", async () => {
    const lead = new Lead([new TooLong("prompt is too long"), reply("S1"), reply("S2"), reply("BOTH")]);
    const { used, result } = run(lead, history, "between");
    expect(await result).toEqual({ messages: [{ role: "user", parts: [{ type: "text", text: `${SHORTENED}BOTH` }] }], summary: "BOTH" });
    expect(lead.seen.slice(1)).toEqual([
      [user("p1"), said("r1"), { role: "user", parts: [instructions] }],
      [user("p2"), said("r2"), { role: "user", parts: [instructions] }],
      combined("S1", "S2"),
    ]);
    // Nothing for the refused whole: it has no usage.
    expect(used).toEqual([
      { provider: "fake:lead", usage },
      { provider: "fake:lead", usage },
      { provider: "fake:lead", usage },
    ]);
  });

  it("splits the same way when the summary is cut off at the window, reporting the cut-off one too", async () => {
    const cut: Turn = { ...reply("half a summ"), cutOff: { kind: "window", detail: "The conversation filled the context window" } };
    const lead = new Lead([cut, reply("S1"), reply("S2"), reply("BOTH")]);
    const { used, result } = run(lead, history, "between");
    expect(await result).toMatchObject({ summary: "BOTH" });
    expect(lead.seen.slice(1).map((m) => m.length)).toEqual([3, 3, 1]);
    expect(used).toHaveLength(4);
  });

  it("splits again when a half is cut off at the output limit", async () => {
    const cut: Turn = { ...reply("half"), cutOff: { kind: "max_tokens", detail: "The response hit the output limit" } };
    const lead = new Lead([new TooLong(), cut, reply("S1a"), reply("S1b"), reply("S1"), reply("S2"), reply("BOTH")]);
    expect(await run(lead, history, "between").result).toMatchObject({ summary: "BOTH" });
    expect(lead.seen[2]).toEqual([{ role: "user", parts: [{ type: "text", text: "p1" }, instructions] }]);
    expect(lead.seen[3]).toEqual([said("r1"), { role: "user", parts: [instructions] }]);
    expect(lead.seen[4]).toEqual(combined("S1a", "S1b"));
    expect(lead.seen[6]).toEqual(combined("S1", "S2"));
  });

  it("never splits a call from its result, and returns the problem for one exchange still too long", async () => {
    const c1 = call("c1", "a.txt");
    const lead = new Lead([new TooLong(), reply("S1"), new TooLong()]);
    const { used, result } = run(lead, [user("p1"), asks(c1), results("c1", "x".repeat(5000))], "between");
    expect(await result).toEqual({ problem: ONE_EXCHANGE });
    expect(lead.seen[2]).toEqual([asks(c1), { role: "user", parts: [...results("c1", "x".repeat(5000)).parts, instructions] }]);
    expect(used).toHaveLength(1);
  });
});

describe("problems", () => {
  it("returns cancelled, and changes nothing, when the summary is stopped", async () => {
    const stop = new AbortController();
    const history = [user("hi"), said("hello")];
    const before = structuredClone(history);
    const lead = new Lead([
      () => {
        stop.abort();
        throw new Error("Request was aborted.");
      },
    ]);
    expect(await run(lead, history, "between", { signal: stop.signal }).result).toEqual({ problem: CANCELLED });
    expect(history).toEqual(before);
  });

  it("passes a provider's error and a refusal's detail through", async () => {
    expect(await run(new Lead([new Error("overloaded")]), [user("hi")], "between").result).toEqual({ problem: "overloaded" });
    const refused: Turn = { ...reply(""), cutOff: { kind: "refusal", detail: "The model declined (category: none given)" } };
    expect(await run(new Lead([refused]), [user("hi")], "between").result).toEqual({ problem: "The model declined (category: none given)" });
  });

  it("calls a reply with no text, only calls, empty", async () => {
    const calls: Turn = { parts: [call("c9", "a.txt")], usage };
    expect(await run(new Lead([calls]), [user("hi")], "between").result).toEqual({ problem: EMPTY_SUMMARY });
  });
});

describe("usage", () => {
  it("reports one summary's usage once, declined attempts first, with the provider that served it", async () => {
    const declined = { provider: "fake:first", usage: { ...usage, input: 3 }, priceKnown: false };
    const lead = new Lead([{ ...reply("S"), declined: [declined], servedBy: "fake:other" }]);
    const { used, result } = run(lead, [user("hi")], "between");
    await result;
    expect(used).toEqual([declined, { provider: "fake:other", usage }]);
  });

  it("reports the first half's usage when the second is cancelled", async () => {
    const stop = new AbortController();
    const lead = new Lead([
      new TooLong(),
      reply("S1"),
      () => {
        stop.abort();
        throw new Error("Request was aborted.");
      },
    ]);
    const { used, result } = run(lead, [user("p1"), said("r1"), user("p2"), said("r2")], "between", { signal: stop.signal });
    expect(await result).toEqual({ problem: CANCELLED });
    expect(used).toEqual([{ provider: "fake:lead", usage }]);
  });
});
