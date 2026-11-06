import { describe, expect, it, vi } from "vitest";
import { characters, fits, Sizes } from "../../src/core/fit.js";
import type { CompletionRequest, Message, Provider, ToolSpec, Usage } from "../../src/core/types.js";

// Release 8a plan, Task 10 (choices 16-19; design, "When to shorten").

const usage = (input: number, cacheRead = 0, cacheWrite = 0): Usage => ({ input, output: 7, cacheRead, cacheWrite });
const spec: ToolSpec = { name: "read_file", description: "Reads a file.", inputSchema: { type: "object" } };
const png = { type: "image", id: 1, mediaType: "image/png", data: Buffer.from("a picture's bytes") } as const;

// A fake lead; `count` makes it Anthropic-like, with countTokens.
function lead(count?: (req: CompletionRequest) => Promise<number>): Provider {
  return { id: "fake:model", complete: () => Promise.reject(new Error("not sent")), ...(count ? { countTokens: vi.fn(count) } : {}) };
}

// A request of exactly 100 characters, so a ratio of 0.25 makes it 25 tokens, with no rounding.
const system = "s".repeat(100 - JSON.stringify({ system: "", parts: [], tools: [] }).length);
const req: CompletionRequest = { system, messages: [], tools: [] };
const chars = characters(req.system, req.messages, req.tools);

// Sizes that know the fake lead at 0.25 tokens a character.
function known(): Sizes {
  const sizes = new Sizes();
  sizes.learn("fake:model", 100, usage(25));
  return sizes;
}

describe("characters", () => {
  it("counts the system prompt, text, calls' inputs, results' outputs and specs, as JSON.stringify writes them", () => {
    const messages: Message[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "read_file", input: { path: "a" } }] },
      { role: "user", parts: [{ type: "tool_result", callId: "c1", output: "x", isError: false }] },
    ];
    expect(characters("sys", messages, [spec])).toBe(JSON.stringify({ system: "sys", parts: ["hi", { path: "a" }, "x"], tools: [spec] }).length);
  });

  it("counts a picture as 0 characters", () => {
    const text: Message = { role: "user", parts: [{ type: "text", text: "look" }] };
    expect(characters("sys", [{ ...text, parts: [...text.parts, png] }], [])).toBe(characters("sys", [text], []));
  });

  // The decision on sent(): only the parts are read, so a reply's lead and a provider's native copy never count.
  it("leaves out a reply's lead and its native content", () => {
    const reply: Message = { role: "assistant", parts: [{ type: "text", text: "done" }] };
    const full: Message = { ...reply, lead: "anthropic:claude-opus-5-5", native: { provider: "anthropic", content: [{ type: "thinking" }] } };
    expect(characters("sys", [full], [])).toBe(characters("sys", [reply], []));
  });
});

describe("Sizes", () => {
  it("gives the reported prompt, input plus cache read plus cache write, over the request's characters", () => {
    const sizes = new Sizes();
    sizes.learn("fake:model", 1000, usage(100, 300, 100));
    expect(sizes.estimate("fake:model", 2000)).toBe(1000);
  });

  it("has no ratio for a provider it has not learned, and keeps each provider's own", () => {
    const sizes = new Sizes();
    expect(sizes.estimate("fake:model", 100)).toBeNull();
    sizes.learn("fake:model", 100, usage(50));
    sizes.learn("other:model", 100, usage(20));
    expect(sizes.estimate("fake:model", 100)).toBe(50);
    expect(sizes.estimate("other:model", 100)).toBe(20);
  });

  it("takes the latest request's ratio over an earlier one", () => {
    const sizes = new Sizes();
    sizes.learn("fake:model", 100, usage(50));
    sizes.learn("fake:model", 100, usage(25));
    expect(sizes.estimate("fake:model", 100)).toBe(25);
  });

  // openai.ts reports a reply without usage as 0 tokens.
  it("learns nothing from a prompt reported as 0, keeping an earlier ratio", () => {
    const sizes = new Sizes();
    sizes.learn("fake:model", 100, usage(0));
    expect(sizes.estimate("fake:model", 100)).toBeNull();
    sizes.learn("fake:model", 100, usage(25));
    sizes.learn("fake:model", 100, usage(0));
    expect(sizes.estimate("fake:model", 100)).toBe(25);
  });
});

describe("fits", () => {
  // The fixture the tests below rely on: 100 characters, 25 tokens at the known ratio.
  it("has a request of exactly 100 characters to work with", () => {
    expect(chars).toBe(100);
  });

  it("is true under the limit and false over it on a provider that cannot count", async () => {
    expect(await fits(lead(), req, known(), 30)).toBe(true);
    expect(await fits(lead(), req, known(), 20)).toBe(false);
  });

  // Task 1: "prompt is too long: 1000050 tokens > 1000000 maximum", so only a larger request is refused.
  it("is true at exactly the limit, by the estimate and by the exact count", async () => {
    expect(await fits(lead(), req, known(), 25)).toBe(true);
    expect(await fits(lead(() => Promise.resolve(20)), req, new Sizes(), 20)).toBe(true);
  });

  it("does not count when the estimate says it fits", async () => {
    const p = lead(() => Promise.resolve(1000));
    expect(await fits(p, req, known(), 30)).toBe(true);
    expect(p.countTokens).not.toHaveBeenCalled();
  });

  it("is true on a provider that can count when the estimate is over the limit and the exact count under it", async () => {
    expect(await fits(lead(() => Promise.resolve(15)), req, known(), 20)).toBe(true);
  });

  it("is false when the estimate and the exact count are both over the limit", async () => {
    expect(await fits(lead(() => Promise.resolve(21)), req, known(), 20)).toBe(false);
  });

  it("is null with no ratio on a provider that cannot count", async () => {
    expect(await fits(lead(), req, new Sizes(), 1_000_000)).toBeNull();
  });

  it("counts exactly with no ratio on a provider that can", async () => {
    expect(await fits(lead(() => Promise.resolve(20)), req, new Sizes(), 30)).toBe(true);
    expect(await fits(lead(() => Promise.resolve(40)), req, new Sizes(), 30)).toBe(false);
  });

  // Task 9's review: the count fits pictures as complete() does, so `leftOut` would post its note twice.
  it("sends the count the request without leftOut, and the rest as it was", async () => {
    const signal = new AbortController().signal;
    const full: CompletionRequest = { ...req, signal, leftOut: () => {}, refusedBy: "fake:model" };
    const p = lead(() => Promise.resolve(10));
    await fits(p, full, new Sizes(), 30);
    // Strict, so a `leftOut` key holding undefined would fail too.
    expect(vi.mocked(p.countTokens!).mock.calls[0]![0]).toStrictEqual({ system, messages: [], tools: [], signal, refusedBy: "fake:model" });
  });

  it("falls back to the estimate when the count fails, and to null with no ratio", async () => {
    const failing = () => Promise.reject(new Error("Connection error."));
    expect(await fits(lead(failing), req, known(), 20)).toBe(false);
    expect(await fits(lead(failing), req, new Sizes(), 20)).toBeNull();
  });

  it("lets a stopped count's error through", async () => {
    const stop = new AbortController();
    stop.abort();
    const err = new Error("Request was aborted.");
    const p = lead(() => Promise.reject(err));
    await expect(fits(p, { ...req, signal: stop.signal }, known(), 20)).rejects.toBe(err);
    await expect(fits(p, { ...req, signal: stop.signal }, new Sizes(), 20)).rejects.toBe(err);
  });
});
