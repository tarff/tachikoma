import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalName, modelName, switchFields } from "../../src/providers/switching.js";

// Release 8e plan, step 12 (design, "Switching the lead model"; Q10, Q11, Q12, Q20): what a lead switch is described by.
const OPUS = "anthropic:claude-opus-5-5";
const T = Date.UTC(2026, 10, 23, 12);
const MINUTES_5 = 5 * 60_000; // the design's "under 5 minutes"
const fields = (more: Partial<Parameters<typeof switchFields>[0]> = {}) =>
  switchFields({ from: OPUS, to: "anthropic:claude-sonnet-5-5", source: "command", requested: "sonnet", contextTokens: 1000, lastReply: undefined, ...more });

afterEach(() => {
  vi.useRealTimers();
});

describe("canonicalName", () => {
  it("drops a final date from an anthropic model's name", () => {
    expect(canonicalName("anthropic:claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("leaves an undated name unchanged", () => {
    expect(canonicalName(OPUS)).toBe("claude-opus-5-5");
  });

  it("gives none for another provider's model, an Anthropic model's name under another provider included", () => {
    expect(canonicalName("openai:gpt-5.5")).toBeUndefined();
    expect(canonicalName("openrouter:anthropic/claude-haiku-4-5-20251001")).toBeUndefined();
    expect(canonicalName("ollama:claude-haiku-4-5-20251001")).toBeUndefined();
  });
});

describe("modelName", () => {
  it("gives the name without its provider, keeping a colon inside the model part", () => {
    expect(modelName(OPUS)).toBe("claude-opus-5-5");
    expect(modelName("ollama:qwen3:8b")).toBe("qwen3:8b");
  });
});

describe("switchFields", () => {
  it("names both models without their provider, a colon inside the model part kept", () => {
    const f = fields({ from: "ollama:qwen3:8b", to: OPUS });
    expect([f.from_model, f.to_model]).toEqual(["qwen3:8b", "claude-opus-5-5"]);
  });

  it("gives requested_model as handed in for a command, and null for a pick and for resume", () => {
    expect(fields({ source: "command", requested: "sonnet" }).requested_model).toBe("sonnet");
    expect(fields({ source: "picker", requested: "sonnet" }).requested_model).toBeNull();
    expect(fields({ source: "resume", requested: "sonnet" }).requested_model).toBeNull();
    expect(fields({ source: "picker" }).source).toBe("picker");
  });

  it("passes context_tokens through, 0 included", () => {
    expect(fields({ contextTokens: 12_345 }).context_tokens).toBe(12_345);
    expect(fields({ contextTokens: 0 }).context_tokens).toBe(0);
  });

  it("always gives cache_ttl 5m", () => {
    expect(fields().cache_ttl).toBe("5m");
    expect(fields({ from: "openai:gpt-5.5", to: "openai:gpt-5.4" }).cache_ttl).toBe("5m");
  });

  it("prices the cache write at the new model's cache-write price per million tokens, from the price list", () => {
    // claude-opus-5-5's cache write is 5 USD a million tokens (pricing.ts).
    expect(fields({ to: OPUS, contextTokens: 200_000 })).toMatchObject({ estimated_cache_write_usd: 1, pricing: "catalog" });
    expect(fields({ to: OPUS, contextTokens: 0 })).toMatchObject({ estimated_cache_write_usd: 0, pricing: "catalog" });
  });

  it("gives null with no pricing for a model the price list has no price for", () => {
    const f = fields({ to: "openai:gpt-5.5", contextTokens: 200_000 });
    expect(f.estimated_cache_write_usd).toBeNull();
    expect(f).not.toHaveProperty("pricing");
    expect(fields({ to: "chatgpt:gpt-6.1-sol" })).not.toHaveProperty("pricing");
  });

  describe("prompt_cache_warm", () => {
    const at = (now: number, more: Partial<Parameters<typeof switchFields>[0]> = {}) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      return fields({ lastReply: { lead: OPUS, at: T }, ...more }).prompt_cache_warm;
    };

    it("is true just under 5 minutes after the Anthropic lead's last reply, and false just over and at 5", () => {
      expect(at(T + MINUTES_5 - 1)).toBe(true);
      expect(at(T + MINUTES_5)).toBe(false);
      expect(at(T + MINUTES_5 + 1)).toBe(false);
    });

    it("is false when the lead is not an Anthropic model", () => {
      const lead = "openrouter:anthropic/claude-opus-5-5";
      expect(at(T + 1, { from: lead, lastReply: { lead, at: T } })).toBe(false);
      expect(at(T + 1, { from: "openai:gpt-5.5", lastReply: { lead: "openai:gpt-5.5", at: T } })).toBe(false);
    });

    it("is false with no reply yet, and when the last reply was another lead's", () => {
      expect(at(T + 1, { lastReply: undefined })).toBe(false);
      expect(at(T + 1, { lastReply: { lead: "openai:gpt-5.5", at: T } })).toBe(false);
    });
  });
});
