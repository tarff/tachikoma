import { describe, expect, it } from "vitest";
import { Stats } from "../../src/core/stats.js";
import type { Provider } from "../../src/core/types.js";
import { judge } from "../../src/safety/judge.js";
import { Bus, reply } from "../helpers.js";

describe("Stats", () => {
  it("adds the judge's usage to the tokens and cost, and leaves the lead's context alone", async () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 } });
    expect(stats.context).toBe(2500);

    // A priced id, so the cost is checked: 1,000 input and 100 output tokens at 4 and 20 USD a million (pricing.ts).
    const j: Provider = {
      id: "anthropic:claude-opus-5-5",
      complete: async () => ({ ...reply('{"allow": true}'), usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } }),
    };
    const action = { kind: "read", outside: true, summary: "read /made/up/file" } as const;
    expect(await judge(j, { prompts: ["go"], calls: [], action, instructions: "" }, new AbortController().signal, bus)).toEqual({ allow: true });
    expect(stats.input).toBe(3000);
    expect(stats.output).toBe(600);
    expect(stats.cost).toBeCloseTo((2000 * 4 + 500 * 20 + 1000 * 4 + 100 * 20) / 1_000_000, 12);
    expect(stats.context).toBe(2500);
  });

  // Release 8a plan, Task 12: a shortening's summary request is not the conversation's.
  it("adds a summary request's usage to the tokens and cost, and leaves the lead's context alone", () => {
    const bus = new Bus();
    const stats = new Stats(bus);
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 } });
    bus.emit("usage", { provider: "anthropic:claude-opus-5-5", usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, summary: true });
    expect([stats.input, stats.output, stats.context]).toEqual([3000, 600, 2500]);
    // 4 and 20 USD a million input and output tokens (pricing.ts), as above.
    expect(stats.cost).toBeCloseTo((3000 * 4 + 600 * 20) / 1_000_000, 12);
  });
});
