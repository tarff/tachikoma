import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cost } from "../../src/providers/pricing.js";
import { createProvider, parseLead } from "../../src/providers/registry.js";

afterEach(() => vi.unstubAllEnvs());

describe("parseLead", () => {
  it("splits at the first colon only", () => {
    expect(parseLead("anthropic:claude-opus-5-5")).toEqual({ kind: "anthropic", model: "claude-opus-5-5" });
    expect(parseLead("ollama:qwen3:8b")).toEqual({ kind: "ollama", model: "qwen3:8b" });
  });

  it.each(["claude", ":model", "openai:"])("rejects %s", (spec) => {
    expect(() => parseLead(spec)).toThrow("Expected <provider>:<model>");
  });
});

describe("createProvider", () => {
  it("names unknown providers and lists the known ones", () => {
    expect(() => createProvider("acme:x")).toThrow('Unknown provider "acme". Known: anthropic, chatgpt, openai, openrouter, kimi, ollama');
  });

  it("refuses a ChatGPT lead while signed out, naming the command", () => {
    vi.stubEnv("TACHI_DATA_DIR", path.join(mkdtempSync(path.join(tmpdir(), "tachi-reg-")), "data"));
    expect(() => createProvider("chatgpt:gpt-6.1-sol")).toThrow("Not signed in to ChatGPT. Sign in to ChatGPT with `tachi login chatgpt`");
  });

  it("does not mistake names every object has for providers", () => {
    expect(() => createProvider("constructor:x")).toThrow('Unknown provider "constructor"');
  });

  it("says which key is missing", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(() => createProvider("openrouter:some/model")).toThrow("Set OPENROUTER_API_KEY to use openrouter");
  });

  it("needs no key for Ollama", () => {
    expect(createProvider("ollama:qwen3:8b").id).toBe("ollama:qwen3:8b");
  });
});

describe("cost", () => {
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
  it("prices known models", () => {
    expect(cost("anthropic:claude-opus-5-5", u)).toBeCloseTo(4 + 20 + 0.2 + 5);
  });
  it("counts local models as free and unknown ones as unknown", () => {
    expect(cost("ollama:qwen3:8b", u)).toBe(0);
    expect(cost("chatgpt:gpt-6.1-sol", u)).toBe(0); // billed to the plan
    expect(cost("openai:some-model", u)).toBeNull();
  });
});
